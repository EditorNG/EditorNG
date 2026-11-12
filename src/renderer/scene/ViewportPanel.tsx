import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import {
  MousePointer2, CirclePlus, Spline, Triangle, Tag, Box, Eye, Layers as LayersIcon, Grid3x3, Maximize, Focus, Tags, Shapes, Scan, Ghost, Cuboid, Lightbulb,
  CircleDot, Minus, Waves,
} from 'lucide-react';
import { Viewport } from './viewport';
import { Layers } from './layers';
import { ws, useWs } from '../project/workspace';
import { useSettings, settings, matches } from '../state/settings';
import { useSel, resolveSel, addToSel, cloneSel, emptySel, setSel, selNodeIdx, selCount, type Hover, type PickMode } from '../state/selection';
import { useUi, type Tool } from '../state/ui';
import { revealRange } from '../editor/CodeEditor';
import * as ops from '../project/ops';
import { toast } from '../state/toast';
import { suggestName } from '../editor/jbeamLang';
import { Inspector } from './Inspector';
import { meshes, useMeshStatus } from './meshes';
import { meshFiles } from '../project/workspace';
import { command } from '../ui/commands';

let vpInstance: Viewport | null = null;
let layersInstance: Layers | null = null;
export const getViewport = () => vpInstance;
export const getLayers = () => layersInstance;

type Modal = {
  type: 'move' | 'scale' | 'rotate';
  start: { x: number; y: number };
  centroid: THREE.Vector3;
  cScreen: { x: number; y: number };
  initial: Map<number, [number, number, number]>;
  axis: null | 'x' | 'y' | 'z';
  numeric: string;
  current: Map<number, [number, number, number]>;
  info: string;
};

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function inTextInput(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.closest('.monaco-editor')) return true;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

export function ViewportPanel() {
  const host = useRef<HTMLDivElement>(null);
  const s = useSettings((x) => x.s);
  const vehicle = useWs((x) => x.vehicle);
  const sel = useSel((x) => x.sel);
  const highlight = useSel((x) => x.highlight);
  const hover = useSel((x) => x.hover);
  const mode = useSel((x) => x.mode);
  const focusPart = useSel((x) => x.focusPart);
  const tool = useUi((x) => x.tool);
  const meshStatus = useMeshStatus();
  const [box, setBox] = useState<null | { x0: number; y0: number; x1: number; y1: number }>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const modalRef = useRef<Modal | null>(null);
  const [nameInput, setNameInput] = useState<null | { x: number; y: number; value: string; node?: string; create?: [number, number, number]; queue?: string[] }>(null);
  const [chain, setChain] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<null | { x: number; y: number; hit: Hover | null }>(null);
  const mouse = useRef({ x: 0, y: 0, inside: false });
  const down = useRef<null | { x: number; y: number; button: number; shift: boolean; ctrl: boolean; alt: boolean; moved: boolean }>(null);

  modalRef.current = modal;

  // ------------------------------------------------------------------ lifecycle
  useEffect(() => {
    const vp = new Viewport(host.current!, settings());
    const layers = new Layers(vp, settings());
    vpInstance = vp;
    layersInstance = layers;
    applyThemeColors();
    const mo = new MutationObserver(applyThemeColors);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => {
      mo.disconnect();
      vp.dispose();
      vpInstance = null;
      layersInstance = null;
    };
  }, []);

  useEffect(() => {
    vpInstance?.applySettings(s);
    layersInstance?.applySettings(s);
  }, [s]);

  useEffect(() => {
    const vp = vpInstance;
    if (!vp) return;
    vp.setVehicle(vehicle);
    meshes.setFiles(meshFiles);
    layersInstance?.setVehicle(vehicle);
    setChain([]);
  }, [vehicle]);

  useEffect(() => {
    if (!vpInstance) return;
    const v = ws.vehicle;
    const si = resolveSel(v, sel);
    const hi = resolveSel(v, highlight);
    vpInstance.setSelection(si);
    vpInstance.setHighlight(hi);
    layersInstance?.applySelection(si, hi, hover);
  }, [sel, highlight, vehicle, hover]);

  useEffect(() => {
    vpInstance?.setHover(hover);
  }, [hover]);

  useEffect(() => {
    vpInstance?.setFocusPart(focusPart);
  }, [focusPart]);

  useEffect(() => {
    if (s.showMeshes && vehicle) layersInstance?.setVehicle(vehicle);
  }, [s.showMeshes, s.meshColorByPart, s.meshWireframe]);

  // chain preview labels
  useEffect(() => {
    const vp = vpInstance;
    if (!vp) return;
    vp.extraLabels = [];
    vp.requestRender();
  }, [chain]);

  // ------------------------------------------------------------------ helpers
  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pickAt = useCallback((x: number, y: number, alt = false): Hover | null => {
    const vp = vpInstance;
    if (!vp) return null;
    if (alt) return layersInstance?.pick(x, y) ?? vp.pick(x, y, useSel.getState().mode);
    const hit = vp.pick(x, y, useSel.getState().mode);
    if (hit) return hit;
    return useSel.getState().mode === 'all' ? layersInstance?.pick(x, y) ?? null : null;
  }, []);

  const revealHit = (hit: Hover) => {
    const v = ws.vehicle;
    if (!v || !settings().revealOnSelect) return;
    const row =
      hit.kind === 'node' ? v.nodes[hit.idx]?.row : hit.kind === 'beam' ? v.beams[hit.idx]?.row : hit.kind === 'tri' ? v.tris[hit.idx]?.row
        : hit.kind === 'flex' ? v.flexbodies[hit.idx]?.row : hit.kind === 'prop' ? v.props[hit.idx]?.row : hit.kind === 'wheel' ? v.wheels[hit.idx]?.row
        : (v.tables.get('triggers2') ?? [])[hit.idx];
    if (!row) return;
    revealRange(row.src.file, row.src.node.s, row.src.node.e);
    const d = ws.doc(row.src.file);
    if (d?.writable && !d.isCommon) ws.setTarget(d.key, row.src.part);
  };

  const selectionNodeIdx = (): number[] => {
    const v = ws.vehicle;
    if (!v) return [];
    return [...selNodeIdx(v, resolveSel(v, useSel.getState().sel))];
  };

  // ------------------------------------------------------------------ modal transforms
  const startModal = (type: Modal['type']) => {
    const vp = vpInstance;
    const v = ws.vehicle;
    if (!vp || !v) return;
    const idx = selectionNodeIdx();
    if (!idx.length) {
      toast('info', 'Select nodes first');
      return;
    }
    const initial = new Map<number, [number, number, number]>();
    const c = new THREE.Vector3();
    for (const i of idx) {
      const p: [number, number, number] = [vp.pos[i * 3], vp.pos[i * 3 + 1], vp.pos[i * 3 + 2]];
      initial.set(i, p);
      c.x += p[0];
      c.y += p[1];
      c.z += p[2];
    }
    c.divideScalar(idx.length);
    const cs = vp.project(c.x, c.y, c.z);
    const m: Modal = { type, start: { ...mouse.current }, centroid: c, cScreen: cs, initial, axis: null, numeric: '', current: new Map(initial), info: '' };
    setModal(m);
  };

  const updateModal = (m: Modal) => {
    const vp = vpInstance;
    if (!vp) return;
    const cur = mouse.current;
    const out = new Map<number, [number, number, number]>();
    const num = m.numeric !== '' && m.numeric !== '-' ? parseFloat(m.numeric) : NaN;
    const snap = settings().snapGrid;
    const ctrl = (window as any).__ctrlDown === true;
    let info = '';
    if (m.type === 'move') {
      const a = vp.pointOnViewPlane(m.start.x, m.start.y, m.centroid);
      const b = vp.pointOnViewPlane(cur.x, cur.y, m.centroid);
      let d = b.sub(a);
      if (m.axis) {
        const ax = AXES[m.axis];
        d = ax.clone().multiplyScalar(Number.isFinite(num) ? num : d.dot(ax));
      } else if (Number.isFinite(num)) d = new THREE.Vector3(num, 0, 0);
      if (ctrl && snap > 0) d.set(Math.round(d.x / snap) * snap, Math.round(d.y / snap) * snap, Math.round(d.z / snap) * snap);
      for (const [i, p] of m.initial) out.set(i, [p[0] + d.x, p[1] + d.y, p[2] + d.z]);
      info = `Move  Δ ${d.x.toFixed(4)}, ${d.y.toFixed(4)}, ${d.z.toFixed(4)}  (${d.length().toFixed(4)} m)`;
    } else if (m.type === 'scale') {
      const d0 = Math.hypot(m.start.x - m.cScreen.x, m.start.y - m.cScreen.y) || 1;
      const d1 = Math.hypot(cur.x - m.cScreen.x, cur.y - m.cScreen.y);
      let f = Number.isFinite(num) ? num : d1 / d0;
      if (ctrl && !Number.isFinite(num)) f = Math.round(f * 10) / 10;
      const c = m.centroid;
      for (const [i, p] of m.initial) {
        const q: [number, number, number] = [...p];
        if (!m.axis || m.axis === 'x') q[0] = c.x + (p[0] - c.x) * f;
        if (!m.axis || m.axis === 'y') q[1] = c.y + (p[1] - c.y) * f;
        if (!m.axis || m.axis === 'z') q[2] = c.z + (p[2] - c.z) * f;
        out.set(i, q);
      }
      info = `Scale  ${f.toFixed(4)}`;
    } else {
      const a0 = Math.atan2(m.start.y - m.cScreen.y, m.start.x - m.cScreen.x);
      const a1 = Math.atan2(cur.y - m.cScreen.y, cur.x - m.cScreen.x);
      let ang = Number.isFinite(num) ? (num * Math.PI) / 180 : -(a1 - a0);
      if (ctrl && !Number.isFinite(num)) ang = Math.round(ang / (Math.PI / 36)) * (Math.PI / 36);
      const axis = m.axis ? AXES[m.axis].clone() : vp.viewDir().negate();
      if (m.axis) {
        // rotate in the screen direction the user expects
        if (axis.dot(vp.viewDir()) > 0) ang = -ang;
      }
      const q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
      const c = m.centroid;
      const t = new THREE.Vector3();
      for (const [i, p] of m.initial) {
        t.set(p[0] - c.x, p[1] - c.y, p[2] - c.z).applyQuaternion(q);
        out.set(i, [c.x + t.x, c.y + t.y, c.z + t.z]);
      }
      info = `Rotate  ${((ang * 180) / Math.PI).toFixed(2)}°`;
    }
    if (m.axis) info += `   along ${m.axis.toUpperCase()}`;
    if (m.numeric) info += `   [${m.numeric}]`;
    m.current = out;
    m.info = info;
    vp.previewPositions(out);
    setModal({ ...m });
  };

  const confirmModal = () => {
    const m = modalRef.current;
    if (!m) return;
    setModal(null);
    let changed = false;
    for (const [i, p] of m.current) {
      const q = m.initial.get(i)!;
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 1e-7) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      vpInstance?.resetPositions();
      return;
    }
    if (!ops.moveNodes(m.current, m.type === 'move' ? 'Move nodes' : m.type === 'scale' ? 'Scale nodes' : 'Rotate nodes')) vpInstance?.resetPositions();
  };

  const cancelModal = () => {
    setModal(null);
    vpInstance?.resetPositions();
  };

  // ------------------------------------------------------------------ naming
  const openNameInput = (nodeIdx: number) => {
    const v = ws.vehicle;
    const vp = vpInstance;
    if (!v || !vp) return;
    const n = v.nodes[nodeIdx];
    const p = vp.project(n.x, n.y, n.z);
    setNameInput({ x: p.x, y: p.y, value: n.name, node: n.name });
  };

  const commitName = (value: string, advance: boolean) => {
    const ni = nameInput;
    setNameInput(null);
    if (!ni) return;
    if (ni.create) {
      const [x, y, z] = ni.create;
      const names = [value];
      const nodes = [{ name: value, x, y, z }];
      const nm = useUi.getState().naming;
      const mn = ops.mirrorName(value);
      if (nm.mirror && Math.abs(x) > settings().namingCenterTolerance && mn && !ws.vehicle?.nodeIndex.has(mn)) {
        nodes.push({ name: mn, x: -x, y, z });
        names.push(mn);
      }
      const made = ops.addNodes(nodes);
      if (made.length) ops.selectNodesByName(made);
      return;
    }
    if (ni.node && value && value !== ni.node) ops.renameNode(ni.node, value);
    if (advance && ni.queue?.length) {
      const [next, ...rest] = ni.queue;
      const v = ws.vehicle;
      const i = v?.nodeIndex.get(next);
      if (v && i !== undefined && vpInstance) {
        const p = vpInstance.project(v.nodes[i].x, v.nodes[i].y, v.nodes[i].z);
        setNameInput({ x: p.x, y: p.y, value: next, node: next, queue: rest });
      }
    }
  };

  /** "Name" tool: names a clicked node with the next sequential name (and its mirror twin). */
  const autoName = (idx: number) => {
    const v = ws.vehicle;
    if (!v) return;
    const st = useUi.getState().naming;
    const n = v.nodes[idx];
    let num = st.next;
    const taken = new Set(v.nodeIndex.keys());
    taken.delete(n.name);
    let name = ops.sidedName(st.prefix, num, n.x);
    while (taken.has(name)) name = ops.sidedName(st.prefix, ++num, n.x);
    const pairs: Array<[string, string]> = [[n.name, name]];
    if (st.mirror && Math.abs(n.x) > settings().namingCenterTolerance) {
      const tol = Math.max(settings().mirrorTolerance, 0.002);
      const twin = v.nodes.find((m) => m !== n && Math.abs(m.x + n.x) < tol && Math.abs(m.y - n.y) < tol && Math.abs(m.z - n.z) < tol);
      if (twin) {
        const tn = ops.sidedName(st.prefix, num, twin.x);
        if (!taken.has(tn) || tn === twin.name) pairs.push([twin.name, tn]);
      }
    }
    const real = pairs.filter(([a, b]) => a !== b);
    if (!real.length || ops.renameMany(real)) {
      useUi.setState({ naming: { ...st, next: num + 1 } });
      toast('ok', real.map(([a, b]) => `${a} → ${b}`).join(', ') || `${name} (unchanged)`, undefined, 1400);
    }
  };

  // ------------------------------------------------------------------ pointer events
  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    host.current?.focus();
    setCtxMenu(null);
    if (modalRef.current) {
      e.preventDefault();
      if (e.button === 0) confirmModal();
      else if (e.button === 2) cancelModal();
      return;
    }
    if (e.button !== 0) {
      down.current = { x: p.x, y: p.y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, moved: false };
      return;
    }
    down.current = { x: p.x, y: p.y, button: 0, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    mouse.current = { x: p.x, y: p.y, inside: true };
    (window as any).__ctrlDown = e.ctrlKey;
    if (modalRef.current) {
      updateModal(modalRef.current);
      return;
    }
    const d = down.current;
    if (d && d.button === 0) {
      if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
      if (d.moved && useUi.getState().tool === 'select') setBox({ x0: d.x, y0: d.y, x1: p.x, y1: p.y });
      return;
    }
    if (d && d.button !== 0) {
      if (Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
      return;
    }
    // hover
    const h = pickAt(p.x, p.y, e.altKey);
    const cur = useSel.getState().hover;
    if (cur?.kind !== h?.kind || cur?.idx !== h?.idx) useSel.setState({ hover: h });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d) return;
    const p = local(e);
    const v = ws.vehicle;
    if (d.button === 2 && !d.moved) {
      const hit = pickAt(p.x, p.y, e.altKey);
      if (v && hit) {
        const tmp = emptySel();
        addToSel(v, tmp, hit.kind, hit.idx);
        const cur = useSel.getState().sel;
        const already = [...tmp.nodes].every((k) => cur.nodes.has(k)) && [...tmp.beams].every((k) => cur.beams.has(k)) && [...tmp.tris].every((k) => cur.tris.has(k)) && selCount(tmp) > 0;
        if (!already) setSel(tmp, hit);
      }
      setCtxMenu({ x: p.x, y: p.y, hit });
      return;
    }
    if (d.button !== 0 || !v) return;
    const t = useUi.getState().tool;
    if (box) {
      const vp = vpInstance!;
      const r = vp.boxSelect(box.x0, box.y0, box.x1, box.y1, useSel.getState().mode);
      setBox(null);
      const s = d.shift || d.ctrl ? cloneSel(useSel.getState().sel) : emptySel();
      const apply = (kind: 'node' | 'beam' | 'tri', list: number[]) => {
        for (const i of list) {
          if (d.ctrl) {
            const tmp = emptySel();
            addToSel(v, tmp, kind, i);
            for (const k of tmp.nodes) s.nodes.delete(k);
            for (const k of tmp.beams) s.beams.delete(k);
            for (const k of tmp.tris) s.tris.delete(k);
          } else addToSel(v, s, kind, i);
        }
      };
      apply('node', r.nodes);
      apply('beam', r.beams);
      apply('tri', r.tris);
      setSel(s);
      return;
    }
    if (d.moved) return;
    const hit = pickAt(p.x, p.y, d.alt);
    const pr = useUi.getState().pick;
    if (pr) {
      if (hit?.kind === 'node') pr.cb(v.nodes[hit.idx].name);
      return;
    }
    if (t === 'select') {
      const s = d.shift || d.ctrl ? cloneSel(useSel.getState().sel) : emptySel();
      if (hit) {
        addToSel(v, s, hit.kind, hit.idx, d.shift || d.ctrl);
        setSel(s, hit);
        revealHit(hit);
      } else if (!d.shift && !d.ctrl) setSel(s);
      return;
    }
    if (t === 'name') {
      if (hit?.kind === 'node') {
        if (d.alt) openNameInput(hit.idx);
        else autoName(hit.idx);
      }
      return;
    }
    if (t === 'addNode') {
      const vp = vpInstance!;
      // place on the view plane through the selection centre / orbit target, or snap onto a hovered node's plane
      let through = vp.controls.target.clone();
      const si = selectionNodeIdx();
      if (hit?.kind === 'node') through = new THREE.Vector3(v.nodes[hit.idx].x, v.nodes[hit.idx].y, v.nodes[hit.idx].z);
      else if (si.length) through = new THREE.Vector3(vp.pos[si[0] * 3], vp.pos[si[0] * 3 + 1], vp.pos[si[0] * 3 + 2]);
      const w = vp.pointOnViewPlane(p.x, p.y, through);
      const snap = settings().snapGrid;
      if (d.ctrl && snap > 0) w.set(Math.round(w.x / snap) * snap, Math.round(w.y / snap) * snap, Math.round(w.z / snap) * snap);
      const nm = useUi.getState().naming;
      const taken = new Set(v.nodeIndex.keys());
      let num = nm.next;
      let name = ops.sidedName(nm.prefix, num, w.x);
      while (taken.has(name)) name = ops.sidedName(nm.prefix, ++num, w.x);
      setNameInput({ x: p.x, y: p.y, value: name, create: [w.x, w.y, w.z] });
      return;
    }
    if (t === 'beam') {
      if (hit?.kind !== 'node') {
        setChain([]);
        return;
      }
      const name = v.nodes[hit.idx].name;
      if (chain.length && !d.shift && chain[chain.length - 1] !== name) ops.addBeams([[chain[chain.length - 1], name]]);
      setChain([name]);
      ops.selectNodesByName([name]);
      return;
    }
    if (t === 'tri') {
      if (hit?.kind !== 'node') {
        setChain([]);
        return;
      }
      const name = v.nodes[hit.idx].name;
      if (chain.includes(name)) return;
      const next = [...chain, name];
      if (next.length === 3) {
        ops.addTris([[next[0], next[1], next[2]]]);
        // strip: keep the last edge, reversed, so the next triangle has the same winding
        setChain(d.shift ? [] : [next[2], next[1]]);
      } else setChain(next);
      ops.selectNodesByName(next.length === 3 ? [next[1], next[2]] : next);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const hit = pickAt(p.x, p.y);
    if (hit?.kind === 'node') openNameInput(hit.idx);
    else if (!hit) vpInstance?.frameNodes(null);
  };

  // ------------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inTextInput() || nameInput) return;
      if (useUi.getState().page !== 'workbench') return;
      if (!mouse.current.inside && !host.current?.contains(document.activeElement)) return;
      const vp = vpInstance;
      const v = ws.vehicle;
      const m = modalRef.current;
      if (m) {
        e.preventDefault();
        e.stopPropagation();
        const k = e.key.toLowerCase();
        if (k === 'escape') cancelModal();
        else if (k === 'enter') confirmModal();
        else if (k === 'x' || k === 'y' || k === 'z') {
          m.axis = m.axis === k ? null : (k as 'x' | 'y' | 'z');
          updateModal(m);
        } else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && m.numeric === '')) {
          m.numeric += e.key;
          updateModal(m);
        } else if (e.key === '-') {
          m.numeric = m.numeric.startsWith('-') ? m.numeric.slice(1) : '-' + m.numeric;
          updateModal(m);
        } else if (e.key === 'Backspace') {
          m.numeric = m.numeric.slice(0, -1);
          updateModal(m);
        }
        return;
      }
      if (!vp) return;
      const run = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      const setTool = (t: Tool) => run(() => {
        useUi.setState({ tool: t });
        setChain([]);
      });
      const setMode = (pm: PickMode) => run(() => useSel.setState({ mode: useSel.getState().mode === pm ? 'all' : pm }));
      if (e.key === 'Escape') {
        const pr = useUi.getState().pick;
        if (pr) return run(() => pr.cb(''));
        if (chain.length) return run(() => setChain([]));
        if (useUi.getState().tool !== 'select') return setTool('select');
        return run(() => setSel(emptySel()));
      }
      if (matches('transform.grab', e)) return run(() => startModal('move'));
      if (matches('transform.scale', e)) return run(() => startModal('scale'));
      if (matches('transform.rotate', e)) return run(() => startModal('rotate'));
      if (matches('tool.select', e)) return setTool('select');
      if (matches('tool.addNode', e)) return setTool('addNode');
      if (matches('tool.beam', e)) return setTool('beam');
      if (matches('tool.tri', e)) return setTool('tri');
      if (matches('tool.name', e)) return setTool('name');
      if (matches('mode.nodes', e)) return setMode('nodes');
      if (matches('mode.beams', e)) return setMode('beams');
      if (matches('mode.tris', e)) return setMode('tris');
      if (!v) return;
      const sel = useSel.getState().sel;
      if (matches('edit.flipTri', e)) return run(() => ops.flipTris(resolveSel(v, sel).tris));
      if (matches('edit.connect', e) && (sel.nodes.size >= 2)) {
        return run(() => {
          const names = [...sel.nodes];
          if (names.length === 3) ops.addTris([[names[0], names[1], names[2]]]);
          else if (names.length === 2) ops.addBeams([[names[0], names[1]]]);
          else {
            const pairs: Array<[string, string]> = [];
            for (let i = 1; i < names.length; i++) pairs.push([names[i - 1], names[i]]);
            ops.addBeams(pairs, undefined, 'Connect chain');
          }
        });
      }
      if (matches('view.frame', e) || matches('view.frameSelected', e)) {
        return run(() => {
          const idx = selectionNodeIdx();
          vp.frameNodes(idx.length ? idx : null);
        });
      }
      if (matches('view.frameAll', e)) return run(() => vp.frameNodes(null));
      if (matches('view.front', e)) return run(() => vp.setView('front'));
      if (matches('view.back', e)) return run(() => vp.setView('back'));
      if (matches('view.side', e)) return run(() => vp.setView('right'));
      if (matches('view.sideOther', e)) return run(() => vp.setView('left'));
      if (matches('view.top', e)) return run(() => vp.setView('top'));
      if (matches('view.bottom', e)) return run(() => vp.setView('bottom'));
      if (matches('view.ortho', e)) return run(() => vp.setOrtho(!vp.isOrtho));
      if (matches('view.toggleLabels', e)) return run(() => useSettings.getState().set({ showLabels: settings().showLabels === 'all' ? 'hover' : 'all' }));
      if (matches('view.toggleMeshes', e)) return run(() => useSettings.getState().set({ showMeshes: !settings().showMeshes }));
      if (matches('view.xray', e)) return run(() => useSettings.getState().set({ xray: !settings().xray }));
      if (matches('view.isolatePart', e)) return run(() => toggleIsolate());
      if (matches('select.all', e)) return run(() => {
        const s = emptySel();
        const pm = useSel.getState().mode;
        const fp = useSel.getState().focusPart;
        v.nodes.forEach((n, i) => (pm === 'all' || pm === 'nodes') && (!fp || n.row.part.def.name === fp) && addToSel(v, s, 'node', i));
        if (pm === 'beams') v.beams.forEach((b, i) => (!fp || b.row.part.def.name === fp) && addToSel(v, s, 'beam', i));
        if (pm === 'tris') v.tris.forEach((t, i) => (!fp || t.row.part.def.name === fp) && addToSel(v, s, 'tri', i));
        setSel(s);
      });
      if (matches('select.none', e)) return run(() => setSel(emptySel()));
      if (matches('select.linked', e)) return run(() => selectLinked());
      if (matches('select.mirror', e)) return run(() => {
        const s = cloneSel(sel);
        for (const n of sel.nodes) {
          const mn = ops.mirrorName(n);
          if (mn && v.nodeIndex.has(mn)) s.nodes.add(mn);
        }
        setSel(s);
      });
      if (matches('edit.delete', e) || matches('edit.deleteAlt', e)) {
        if (selCount(sel)) return run(() => {
          if (settings().confirmDelete && !confirm(`Delete ${selCount(sel)} selected element(s)?`)) return;
          ops.deleteSelection();
        });
      }
      if (matches('edit.rename', e)) return run(() => {
        const names = [...sel.nodes];
        if (!names.length) return;
        const i = v.nodeIndex.get(names[0]);
        if (i === undefined) return;
        const p = vp.project(v.nodes[i].x, v.nodes[i].y, v.nodes[i].z);
        setNameInput({ x: p.x, y: p.y, value: names[0], node: names[0], queue: names.slice(1) });
      });
      if (matches('edit.mirror', e)) return run(() => ops.mirrorSelection());
      if (matches('edit.duplicate', e)) return run(() => {
        const idx = selectionNodeIdx();
        const names = ops.duplicateNodes(idx, [0, 0, 0]);
        if (names.length) {
          ops.selectNodesByName(names);
          setTimeout(() => startModal('move'), 30);
        }
      });
    };
    window.addEventListener('keydown', onKey, true);
    const onKeyUp = (e: KeyboardEvent) => ((window as any).__ctrlDown = e.ctrlKey);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  });

  const toggleIsolate = () => {
    const v = ws.vehicle;
    if (!v) return;
    const fp = useSel.getState().focusPart;
    if (fp) return useSel.setState({ focusPart: null });
    const t = useWs.getState().target;
    const act = useSel.getState().active;
    let part: string | null = null;
    if (act?.kind === 'node') part = v.nodes[act.idx]?.row.part.def.name ?? null;
    else if (act?.kind === 'beam') part = v.beams[act.idx]?.row.part.def.name ?? null;
    else if (act?.kind === 'tri') part = v.tris[act.idx]?.row.part.def.name ?? null;
    if (!part && t) part = t.part;
    if (part) useSel.setState({ focusPart: part });
  };

  const selectLinked = () => {
    const v = ws.vehicle;
    if (!v) return;
    const start = selNodeIdx(v, resolveSel(v, useSel.getState().sel));
    if (!start.size) return;
    const adj = new Map<number, number[]>();
    for (const b of v.beams) {
      (adj.get(b.a) ?? adj.set(b.a, []).get(b.a)!).push(b.b);
      (adj.get(b.b) ?? adj.set(b.b, []).get(b.b)!).push(b.a);
    }
    // linked within the same part (otherwise everything is linked)
    const parts = new Set([...start].map((i) => v.nodes[i].row.part.def.name));
    const seen = new Set(start);
    const q = [...start];
    while (q.length) {
      const i = q.pop()!;
      for (const j of adj.get(i) ?? []) {
        if (seen.has(j) || !parts.has(v.nodes[j].row.part.def.name)) continue;
        seen.add(j);
        q.push(j);
      }
    }
    const s = emptySel();
    for (const i of seen) s.nodes.add(v.nodes[i].name);
    setSel(s);
  };

  // ------------------------------------------------------------------ render
  const set = useSettings((x) => x.set);
  const toolBtn = (t: Tool, icon: React.ReactNode, tip: string) => (
    <button className={'icon-btn' + (tool === t ? ' active' : '')} data-tip={tip} data-tip-pos="right" onClick={() => { useUi.setState({ tool: t }); setChain([]); }} aria-label={tip}>
      {icon}
    </button>
  );
  const modeBtn = (m: PickMode, label: string, tip: string) => (
    <button className={'seg' + (mode === m ? ' active' : '')} onClick={() => useSel.setState({ mode: m })} data-tip={tip}>
      {label}
    </button>
  );
  const toggle = (key: keyof typeof s, icon: React.ReactNode, tip: string) => (
    <button className={'icon-btn small' + (s[key] ? ' active' : '')} data-tip={tip} onClick={() => set({ [key]: !s[key] } as any)} aria-label={tip}>
      {icon}
    </button>
  );

  const nm = useUi((x) => x.naming);
  const pickReq = useUi((x) => x.pick);
  const toolHint: Record<Tool, string> = {
    select: '',
    addNode: 'Click to place a node on the view plane (through the selection or orbit centre). Ctrl snaps to grid.',
    beam: chain.length ? `Beam from ${chain[0]} — click the next node (Shift+click starts a new chain, Esc stops)` : 'Click nodes one after another to chain beams',
    tri: chain.length ? `Triangle: ${chain.join(' → ')} — click ${3 - chain.length} more (strip continues, Shift ends)` : 'Click 3 nodes for a collision triangle; keeps going as a strip',
    name: `Click nodes to name them ${nm.prefix}${nm.next}${settings().mirrorSuffixLeft}/${settings().mirrorSuffixRight}…  (Alt+click: type a name)`,
  };

  return (
    <div className="viewport" ref={host} tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => { mouse.current.inside = false; if (!down.current) useSel.setState({ hover: null }); }}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={() => setCtxMenu(null)}
    >
      <div className="vp-toolbar left" onPointerDown={(e) => e.stopPropagation()}>
        {toolBtn('select', <MousePointer2 size={16} />, 'Select (Q)\nDrag: box select · Shift add · Ctrl remove')}
        {toolBtn('addNode', <CirclePlus size={16} />, 'Add node (N)')}
        {toolBtn('beam', <Spline size={16} />, 'Beam chain (B)')}
        {toolBtn('tri', <Triangle size={16} />, 'Collision triangles (T)')}
        {toolBtn('name', <Tag size={16} />, 'Quick naming (E)')}
      </div>

      <div className="vp-toolbar top" onPointerDown={(e) => e.stopPropagation()}>
        <div className="segmented">
          {modeBtn('all', 'All', 'Pick anything')}
          {modeBtn('nodes', 'Nodes', 'Nodes only (1)')}
          {modeBtn('beams', 'Beams', 'Beams only (2)')}
          {modeBtn('tris', 'Tris', 'Triangles only (3)')}
        </div>
        <div className="sep-v" />
        {toggle('showNodes', <CircleDot size={14} />, 'Nodes')}
        {toggle('showBeams', <Minus size={14} />, 'Beams')}
        {toggle('showTris', <Shapes size={14} />, 'Triangles')}
        {toggle('showMeshes', <Box size={14} />, 'Flexbodies (Shift+H)')}
        {toggle('showWheels', <Waves size={14} />, 'Wheels')}
        {toggle('showProps', <Lightbulb size={14} />, 'Props & lights')}
        {toggle('showTriggers', <Cuboid size={14} />, 'Triggers')}
        {toggle('xray', <Ghost size={14} />, 'X-ray: nodes & beams through meshes (Alt+Z)')}
        <button className={'icon-btn small' + (s.showLabels === 'all' ? ' active' : '')} data-tip="Node labels (Shift+L)" onClick={() => set({ showLabels: s.showLabels === 'all' ? 'hover' : 'all' })} aria-label="Labels">
          <Tags size={14} />
        </button>
        {toggle('showGrid', <Grid3x3 size={14} />, 'Grid')}
      </div>

      <div className="vp-toolbar right" onPointerDown={(e) => e.stopPropagation()}>
        <button className="icon-btn small" data-tip="Frame all (Home)" data-tip-pos="left" onClick={() => vpInstance?.frameNodes(null)} aria-label="Frame all"><Maximize size={14} /></button>
        <button className="icon-btn small" data-tip="Frame selection (F)" data-tip-pos="left" onClick={() => { const i = selectionNodeIdx(); vpInstance?.frameNodes(i.length ? i : null); }} aria-label="Frame selection"><Focus size={14} /></button>
        <button className={'icon-btn small' + (focusPart ? ' active' : '')} data-tip={focusPart ? `Isolated: ${focusPart} (Shift+I)` : 'Isolate part of the selection (Shift+I)'} data-tip-pos="left" onClick={toggleIsolate} aria-label="Isolate part"><Scan size={14} /></button>
        <div className="view-cube">
          {([['front', 'F', 'Front (Numpad 1)'], ['back', 'B', 'Back (Ctrl+Numpad 1)'], ['left', 'L', 'Left side (Ctrl+Numpad 3)'], ['right', 'R', 'Right side (Numpad 3)'], ['top', 'T', 'Top (Numpad 7)'], ['bottom', 'U', 'Under (Ctrl+Numpad 7)']] as const).map(([vw, l, tip]) => (
            <button key={vw} className="view-btn" data-tip={tip} data-tip-pos="left" onClick={() => vpInstance?.setView(vw)}>{l}</button>
          ))}
          <button className="view-btn wide" data-tip="Perspective / orthographic (Numpad 5)" data-tip-pos="left" onClick={() => vpInstance?.setOrtho(!vpInstance.isOrtho)}>P/O</button>
        </div>
      </div>

      {tool === 'name' && (
        <div className="vp-naming" onPointerDown={(e) => e.stopPropagation()}>
          <LayersIcon size={13} />
          <span className="dim">Prefix</span>
          <input className="input small mono" style={{ width: 70 }} value={nm.prefix} onChange={(e) => useUi.setState({ naming: { ...nm, prefix: e.target.value } })} />
          <span className="dim">Next #</span>
          <input className="input small mono" style={{ width: 54 }} type="number" value={nm.next} onChange={(e) => useUi.setState({ naming: { ...nm, next: Math.max(0, +e.target.value | 0) } })} />
          <label className="row dim" style={{ gap: 6 }}>
            <button className={'switch' + (nm.mirror ? ' on' : '')} onClick={() => useUi.setState({ naming: { ...nm, mirror: !nm.mirror } })} aria-label="Name mirror twins" />
            Name mirror twin
          </label>
        </div>
      )}

      {pickReq && <div className="vp-hint modal">Click a node for: <b>{pickReq.label}</b> <span className="dim">· Esc cancels</span></div>}
      {!pickReq && toolHint[tool] && !modal && <div className="vp-hint">{toolHint[tool]}</div>}
      {modal && <div className="vp-hint modal">{modal.info || modal.type} <span className="dim">· X/Y/Z axis · type a value · Ctrl snap · Enter/LMB confirm · Esc/RMB cancel</span></div>}
      {box && <div className="box-select" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}

      {nameInput && (
        <input
          className="input name-input mono"
          style={{ left: nameInput.x + 10, top: nameInput.y - 13 }}
          autoFocus
          defaultValue={nameInput.value}
          onFocus={(e) => e.target.select()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitName((e.target as HTMLInputElement).value.trim(), false);
            else if (e.key === 'Tab') {
              e.preventDefault();
              commitName((e.target as HTMLInputElement).value.trim(), true);
            } else if (e.key === 'Escape') setNameInput(null);
          }}
          onBlur={(e) => nameInput && commitName(e.target.value.trim(), false)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hit={ctxMenu.hit}
          close={() => setCtxMenu(null)}
          actions={{
            rename: (i) => openNameInput(i),
            grab: () => startModal('move'),
            isolate: toggleIsolate,
            linked: selectLinked,
          }}
        />
      )}

      <div className="vp-toolbar sliders" onPointerDown={(e) => e.stopPropagation()}>
        <label className="vp-slider" data-tip-pos="top" data-tip="Node size">
          <CircleDot size={12} />
          <input type="range" min={2} max={20} step={0.5} value={s.nodeSize} onChange={(e) => set({ nodeSize: +e.target.value })} />
        </label>
        <label className="vp-slider" data-tip-pos="top" data-tip="Beam width">
          <Minus size={12} />
          <input type="range" min={0.5} max={6} step={0.25} value={s.beamWidth} onChange={(e) => set({ beamWidth: +e.target.value })} />
        </label>
        <label className="vp-slider" data-tip-pos="top" data-tip="Flexbody opacity">
          <Eye size={12} />
          <input type="range" min={0} max={1} step={0.02} value={s.meshOpacity} onChange={(e) => set({ meshOpacity: +e.target.value })} />
        </label>
        <label className="vp-slider" data-tip-pos="top" data-tip="Triangle opacity">
          <Shapes size={12} />
          <input type="range" min={0} max={1} step={0.02} value={s.triOpacity} onChange={(e) => set({ triOpacity: +e.target.value })} />
        </label>
      </div>

      <Inspector />

      <div className="vp-status" onPointerDown={(e) => e.stopPropagation()}>
        {vehicle ? (
          <>
            <span>{vehicle.nodes.length} nodes</span>
            <span>{vehicle.beams.length} beams</span>
            <span>{vehicle.tris.length} tris</span>
            <span>{vehicle.flexbodies.length} flexbodies</span>
            {meshStatus.loading > 0 && <span className="accent-text">loading meshes… ({meshStatus.indexed}/{meshStatus.total} indexed)</span>}
            {meshStatus.missing.length > 0 && <span className="warn-text" data-tip={meshStatus.missing.slice(0, 30).join('\n')} data-tip-pos="top">{meshStatus.missing.length} meshes not found</span>}
          </>
        ) : null}
      </div>
      {!vehicle && <EmptyState />}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="vp-empty">
      <div className="vp-empty-card">
        <div className="vp-empty-title">No vehicle open</div>
        <div className="dim">Pick a vehicle on the left, open a .jbeam file, or start a new vehicle.</div>
        <div className="row" style={{ justifyContent: 'center', marginTop: 12, gap: 8 }}>
          <button className="btn primary" onClick={() => useUi.setState({ dialog: { kind: 'newVehicle' } })}>New vehicle…</button>
          <button className="btn" onClick={() => command('file.openFile')}>Open file…</button>
          <button className="btn" onClick={() => { ws.refreshVehicleList(); useUi.setState({ activity: 'vehicles', sidebar: true, page: 'workbench', palette: 'vehicles' }); }}>Browse vehicles…</button>
        </div>
      </div>
    </div>
  );
}

function ContextMenu(props: { x: number; y: number; hit: Hover | null; close: () => void; actions: { rename: (i: number) => void; grab: () => void; isolate: () => void; linked: () => void } }) {
  const v = ws.vehicle;
  const items: Array<[string, () => void, string?] | null> = [];
  const hit = props.hit;
  if (v && hit?.kind === 'node') items.push(['Rename…', () => props.actions.rename(hit.idx), 'F2']);
  const row = v && hit ? (hit.kind === 'node' ? v.nodes[hit.idx].row : hit.kind === 'beam' ? v.beams[hit.idx].row : hit.kind === 'tri' ? v.tris[hit.idx].row : hit.kind === 'flex' ? v.flexbodies[hit.idx].row : hit.kind === 'prop' ? v.props[hit.idx].row : (v.tables.get('triggers2') ?? [])[hit.idx]) : null;
  if (row) items.push(['Show in code', () => revealRange(row.src.file, row.src.node.s, row.src.node.e, true)]);
  if (row) items.push([`Set "${row.src.part}" as target part`, () => ws.setTarget(row.src.file, row.src.part)]);
  items.push(null);
  items.push(['Move', props.actions.grab, 'G']);
  items.push(['Mirror to other side', () => ops.mirrorSelection(), 'Ctrl+M']);
  items.push(['Select linked', props.actions.linked, 'L']);
  items.push(['Isolate part', props.actions.isolate, 'Shift+I']);
  items.push(null);
  items.push(['Delete', () => ops.deleteSelection(), 'X']);
  return (
    <div className="ctx-menu" style={{ left: props.x, top: props.y }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it ? (
          <button key={i} className="ctx-item" onClick={() => { props.close(); it[1](); }}>
            <span>{it[0]}</span>
            {it[2] && <span className="kbd">{it[2]}</span>}
          </button>
        ) : (
          <div key={i} className="ctx-sep" />
        ),
      )}
    </div>
  );
}

function applyThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--viewport-bottom').trim() || '#15171a';
  const light = document.documentElement.dataset.theme === 'light';
  vpInstance?.setColors({ bg, text: light ? '#1b1f24' : '#e8ebef', textBg: light ? 'rgba(255,255,255,.82)' : 'rgba(14,16,18,.78)' });
  layersInstance?.setColors(light);
}

export { suggestName };
