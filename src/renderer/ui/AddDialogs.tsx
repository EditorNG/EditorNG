/**
 * "New part" (a blank part in a jbeam file) and "Flexbody" (a mesh from the mod's .dae files,
 * previewed, tied to the node groups it sits on) dialogs.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Search, Box, Sparkles } from 'lucide-react';
import { ws, useWs, type Doc } from '../project/workspace';
import { useSettings, settings } from '../state/settings';
import { useUi } from '../state/ui';
import { toast } from '../state/toast';
import { Modal, Field } from './Dialogs';
import { EditSet, insertRowsHere, targetPart } from '../project/ops';
import { DEFAULT_HEADERS, fmtRow, rowFromRecord } from '@core/jbeam/edit';
import { SECTION_DEFS, insertKeyAt, partValue } from '@core/jbeam/sections';
import { scoreGroups, type GroupScore } from '@core/flexfit';
import type { AArr, AObj } from '@core/sjson';
import type { PartDef, SlotNode, Vehicle } from '@core/jbeam/types';
import { meshes } from '../scene/meshes';
import { revealRange } from '../editor/CodeEditor';
import { partAt } from '../editor/addMenu';
import type { VFile } from '@shared/ipc';

const writableJbeams = () => [...ws.docs.values()].filter((d) => d.writable && !d.isCommon && d.lang === 'jbeam' && !d.binary);

function headerOf(part: PartDef, sec: string): string[] {
  const t = part.sections.get(sec);
  if (t && t.k === 'arr' && t.items[0]?.k === 'arr') return (t.items[0] as AArr).items.map((x) => (x.k === 'str' ? x.v : ''));
  return DEFAULT_HEADERS[sec];
}

/** Slots of the vehicle no installed part fills, and their owners. */
function emptySlots(v: Vehicle | null): Array<{ id: string; types: string[]; owner: string; description: string }> {
  const out: Array<{ id: string; types: string[]; owner: string; description: string }> = [];
  const walk = (slots: SlotNode[]) => {
    for (const sn of slots) {
      if (!sn.part) out.push({ id: sn.id, types: sn.def.allowTypes, owner: sn.owner.def.name, description: sn.def.description });
      else walk(sn.part.slots);
    }
  };
  if (v?.root) walk(v.root.slots);
  return out;
}

// ------------------------------------------------------------------------------------------
// New part
// ------------------------------------------------------------------------------------------

const DEFAULT_SECTIONS = ['nodes', 'beams', 'triangles', 'flexbodies'];
const PART_SECTIONS = SECTION_DEFS.filter((s) => s.key !== 'information' && s.key !== 'slotType');

export function NewPartDialog({ close, data }: { close: () => void; data: { doc: string; offset?: number } }) {
  const v = useWs((x) => x.vehicle);
  const model = useWs((x) => x.model);
  const s = useSettings((x) => x.s);
  const files = writableJbeams();
  const [fileKey, setFileKey] = useState(() => (ws.doc(data.doc)?.writable ? ws.doc(data.doc)!.key : files[0]?.key ?? ''));
  const doc = ws.doc(fileKey);
  const at = doc && data.offset !== undefined && doc.key === data.doc ? partAt(doc, data.offset) : null;
  const near = at?.part ?? doc?.jfile?.parts[doc.jfile.parts.length - 1];
  const base = (doc?.name ?? 'part').replace(/\.jbeam$/i, '');
  const [name, setName] = useState(`${base}_new`);
  const [display, setDisplay] = useState('');
  const [displayTouched, setDisplayTouched] = useState(false);
  const [slotType, setSlotType] = useState('');
  const [slotTouched, setSlotTouched] = useState(false);
  const [authors, setAuthors] = useState(near?.info.authors || s.modAuthor || '');
  const [value, setValue] = useState(0);
  const [sections, setSections] = useState<Set<string>>(new Set(DEFAULT_SECTIONS));
  const [where, setWhere] = useState<'after' | 'end'>(near ? 'after' : 'end');
  const [plugInto, setPlugInto] = useState('');
  const slots = useMemo(() => emptySlots(v), [v]);
  const fits = slots.filter((sl) => sl.types.includes(slotType));
  const humanize = (n: string) => {
    const t = model && n.toLowerCase().startsWith(model.toLowerCase() + '_') ? n.slice(model.length + 1) : n;
    return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };
  // display name and slot type follow the part name until edited
  useEffect(() => {
    if (!displayTouched) setDisplay(humanize(name));
    if (!slotTouched) setSlotType(name);
  }, [name]);
  const bad = !/^[A-Za-z0-9_\-]+$/.test(name) ? 'Letters, digits, _ and - only' : ws.partDef(name) ? `${name} already exists` : '';
  const parents = (v?.parts ?? []).filter((p) => ws.doc(p.def.file)?.writable && !ws.doc(p.def.file)?.isCommon);

  const create = () => {
    if (!doc || bad) return;
    const root = doc.jfile?.root;
    if (!root || root.k !== 'obj') return toast('error', `${doc.name} has no top-level object`);
    const idx = where === 'after' && near ? (root as AObj).keys.findIndex((k) => k.v === near.name) : -1;
    const r = insertKeyAt(doc.text, root as AObj, idx >= 0 ? idx + 1 : null, name, (ind, unit, eol) =>
      partValue({ authors, name: display || name, value, slotType: slotType || name, sections: PART_SECTIONS.filter((x) => sections.has(x.key)).map((x) => x.key) }, ind, unit, eol),
    );
    const es = new EditSet();
    es.add(doc.key, r.edits);
    const parent = plugInto && !fits.length ? ws.partDef(plugInto) : undefined;
    const pdoc = parent ? ws.doc(parent.file) : undefined;
    if (parent && pdoc) {
      const useV1 = parent.sections.has('slots') && !parent.sections.has('slots2');
      const sec = useV1 ? 'slots' : 'slots2';
      const header = headerOf(parent, sec) ?? (useV1 ? ['type', 'default', 'description'] : DEFAULT_HEADERS.slots2);
      const rec = useV1 ? { type: slotType || name, default: name, description: display || name } : { name: slotType || name, allowTypes: [slotType || name], denyTypes: [], default: name, description: display || name };
      es.add(pdoc.key, insertRowsHere(pdoc.text, parent, sec, header, [fmtRow(rowFromRecord(header, rec))]));
    }
    if (!es.apply(`New part ${name}`)) return;
    close();
    const def = ws.doc(doc.key)?.jfile?.parts.find((p) => p.name === name);
    if (def) revealRange(doc.key, def.key.s, def.key.e, true);
    if (fits.length || parent) setTimeout(() => ws.focusPart(name), 50);
    toast('ok', `Added part ${name}${fits.length ? ` (fits slot ${fits[0].id})` : parent ? ` (plugged into ${parent.name})` : ''}`);
  };

  return (
    <Modal title="New part" onClose={close} width={600} footer={<>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!!bad || !doc} onClick={create}>Add part</button>
    </>}>
      <div className="grid2">
        <Field label="Part name" hint={bad || 'The key of the part in the file'}>
          <input className={'input mono' + (bad ? ' invalid' : '')} autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </Field>
        <Field label="Name in the parts list" hint="information.name">
          <input className="input" value={display} onChange={(e) => { setDisplay(e.target.value); setDisplayTouched(true); }} />
        </Field>
        <Field label="slotType" hint={fits.length ? `Fits the empty slot "${fits[0].id}" of ${fits[0].owner}` : 'The slot this part goes in'}>
          <input className="input mono" list="np-slot-types" value={slotType} onChange={(e) => { setSlotType(e.target.value.trim()); setSlotTouched(true); }} />
          <datalist id="np-slot-types">{slots.flatMap((sl) => sl.types.map((t) => <option key={sl.id + t} value={t}>{`${sl.description || sl.id} — empty slot of ${sl.owner}`}</option>))}</datalist>
        </Field>
        <div className="grid2" style={{ gap: 8 }}>
          <Field label="Authors"><input className="input" value={authors} onChange={(e) => setAuthors(e.target.value)} /></Field>
          <Field label="Value"><input className="input mono" type="number" value={value} onChange={(e) => setValue(+e.target.value || 0)} /></Field>
        </div>
      </div>
      <Field label="Sections">
        <div className="np-sections">
          {PART_SECTIONS.map((sd) => (
            <label key={sd.key} className="disp-check">
              <input type="checkbox" checked={sections.has(sd.key)} onChange={(e) => {
                const n = new Set(sections);
                if (e.target.checked) n.add(sd.key);
                else n.delete(sd.key);
                setSections(n);
              }} />
              <span className="mono">{sd.key}</span>
            </label>
          ))}
        </div>
      </Field>
      <div className="grid2">
        <Field label="File">
          <select className="select" value={fileKey} onChange={(e) => setFileKey(e.target.value)}>
            {files.map((d: Doc) => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Place it">
          <select className="select" value={where} onChange={(e) => setWhere(e.target.value as 'after' | 'end')}>
            {near && <option value="after">After {near.name}</option>}
            <option value="end">At the end of the file</option>
          </select>
        </Field>
      </div>
      {!fits.length && (
        <Field label="Plug into" hint="Adds a slots2 row in that part, so the new part shows up in the vehicle">
          <select className="select" value={plugInto} onChange={(e) => setPlugInto(e.target.value)}>
            <option value="">Nowhere for now</option>
            {parents.map((p) => <option key={p.def.name} value={p.def.name}>{p.def.name}{p.def.info.name ? ` — ${p.def.info.name}` : ''}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------
// Flexbody
// ------------------------------------------------------------------------------------------

interface MeshEntry {
  name: string;
  file: VFile;
  usedBy: string[];
}

/** The mesh preview: the geometry, lit, with the nodes of the chosen groups; drag to turn, wheel to zoom. */
function MeshPreview(props: { geo: THREE.BufferGeometry | null; loading: boolean; selected: Array<[number, number, number]>; others: Array<[number, number, number]> }) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{ r: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; mesh: THREE.Mesh; wire: THREE.LineSegments; sel: THREE.Points; oth: THREE.Points; yaw: number; pitch: number; dist: number; target: THREE.Vector3; draw: () => void } | null>(null);
  useEffect(() => {
    const el = host.current!;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(r.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe6ef, 0x2a2e34, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-2, -3, 4);
    scene.add(sun);
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    cam.up.set(0, 0, 1);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0xb9c0c9, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5b6573, transparent: true, opacity: 0.35 }));
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff6600';
    // round node markers
    const dot = (() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 32;
      const g2 = cv.getContext('2d')!;
      g2.fillStyle = '#fff';
      g2.beginPath();
      g2.arc(16, 16, 14, 0, Math.PI * 2);
      g2.fill();
      return new THREE.CanvasTexture(cv);
    })();
    const sel = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: new THREE.Color(accent), size: 8, sizeAttenuation: false, depthTest: false, map: dot, alphaTest: 0.5, transparent: true }));
    const oth = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xaab2bc, size: 6, sizeAttenuation: false, map: dot, alphaTest: 0.5, transparent: true, opacity: 0.75 }));
    sel.renderOrder = 2;
    scene.add(mesh, wire, oth, sel);
    const c = { r, scene, cam, mesh, wire, sel, oth, yaw: -0.7, pitch: 0.6, dist: 3, target: new THREE.Vector3(), draw: () => {} };
    c.draw = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      r.setSize(w, h, false);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      const cp = Math.cos(c.pitch);
      cam.position.set(c.target.x + Math.sin(c.yaw) * cp * c.dist, c.target.y - Math.cos(c.yaw) * cp * c.dist, c.target.z + Math.sin(c.pitch) * c.dist);
      cam.lookAt(c.target);
      r.render(scene, cam);
    };
    ctx.current = c;
    let drag: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      c.yaw -= (e.clientX - drag.x) * 0.01;
      c.pitch = Math.max(-1.45, Math.min(1.45, c.pitch + (e.clientY - drag.y) * 0.01));
      drag = { x: e.clientX, y: e.clientY };
      c.draw();
    };
    const up = () => (drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      c.dist *= e.deltaY > 0 ? 1.12 : 1 / 1.12;
      c.draw();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(() => c.draw());
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
      (mesh.material as THREE.Material).dispose();
      (sel.material as THREE.Material).dispose();
      (oth.material as THREE.Material).dispose();
      dot.dispose();
      wire.geometry.dispose();
      sel.geometry.dispose();
      oth.geometry.dispose();
      r.dispose();
      r.domElement.remove();
      ctx.current = null;
    };
  }, []);
  // geometry: shared with the 3D view's cache, never disposed here
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.mesh.geometry = props.geo ?? new THREE.BufferGeometry();
    c.wire.geometry.dispose();
    c.wire.geometry = props.geo ? new THREE.EdgesGeometry(props.geo, 25) : new THREE.BufferGeometry();
    if (props.geo) {
      props.geo.computeBoundingSphere();
      const bs = props.geo.boundingSphere!;
      c.target.copy(bs.center);
      c.dist = Math.max(0.15, bs.radius * 3);
      // frame the mesh itself as seen from the camera (sampled vertices: a curved or flat part fills
      // the view, where its bounding box corners would leave it small), centred on screen
      const arr = props.geo.attributes.position.array as ArrayLike<number>;
      const nv = Math.floor(arr.length / 3);
      const step = Math.max(1, Math.floor(nv / 1500));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < nv; i += step) pts.push(new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]));
      for (let it = 0; it < 5; it++) {
        c.draw();
        c.cam.updateMatrixWorld();
        let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
        for (const p of pts) {
          const q = p.clone().project(c.cam);
          x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
        }
        // move the target to the middle of what is seen, then fit
        const right = new THREE.Vector3().setFromMatrixColumn(c.cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(c.cam.matrixWorld, 1);
        const halfH = c.dist * Math.tan((c.cam.fov * Math.PI) / 360);
        c.target.addScaledVector(right, ((x0 + x1) / 2) * halfH * c.cam.aspect).addScaledVector(up, ((y0 + y1) / 2) * halfH);
        const ext = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
        if (ext > 0) c.dist = Math.max(0.1, c.dist * (ext / 0.8));
      }
    }
    c.draw();
  }, [props.geo]);
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const set = (p: THREE.Points, list: Array<[number, number, number]>) => {
      p.geometry.dispose();
      p.geometry = new THREE.BufferGeometry();
      p.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list.flat()), 3));
    };
    set(c.sel, props.selected);
    set(c.oth, props.others);
    c.draw();
  }, [props.selected, props.others]);
  return (
    <div className="fb-preview" ref={host}>
      {!props.geo && <div className="fb-preview-empty faint">{props.loading ? 'Loading the mesh…' : 'Pick a mesh'}</div>}
    </div>
  );
}

export function FlexbodyDialog({ close, data }: { close: () => void; data?: { doc?: string; part?: string } }) {
  const v = useWs((x) => x.vehicle);
  const model = useWs((x) => x.model);
  // target part: the one asked for, else the target part, else the first editable one
  const parts = writableJbeams().flatMap((d) => (d.jfile?.parts ?? []).map((p) => ({ doc: d, part: p })));
  const [partName, setPartName] = useState(() => {
    if (data?.part && parts.some((p) => p.part.name === data.part)) return data.part;
    const t = targetPart();
    return t?.part.name ?? parts[0]?.part.name ?? '';
  });
  const target = parts.find((p) => p.part.name === partName);
  const [withCommon, setWithCommon] = useState(false);
  const [list, setList] = useState<MeshEntry[] | null>(null);
  const [scan, setScan] = useState<[number, number]>([0, 0]);
  const [q, setQ] = useState('');
  const [hideUsed, setHideUsed] = useState(false);
  const [mesh, setMesh] = useState('');
  const [geo, setGeo] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [gq, setGq] = useState('');
  const [pos, setPos] = useState([0, 0, 0]);
  const [rot, setRot] = useState([0, 0, 0]);
  const [scale, setScale] = useState([1, 1, 1]);

  // meshes of the mod's own .dae files (and vehicles/common on demand)
  useEffect(() => {
    let dead = false;
    const all = meshes.allFiles();
    const own = (f: VFile) => (model ? f.vpath.toLowerCase().startsWith(`vehicles/${model.toLowerCase()}/`) : !/\/vehicles\/common\//i.test(f.vpath));
    const files = all.filter((f) => own(f) || (withCommon && /^vehicles\/common\//i.test(f.vpath)));
    const used = new Map<string, string[]>();
    for (const f of v?.flexbodies ?? []) {
      const k = f.mesh.toLowerCase();
      used.set(k, [...new Set([...(used.get(k) ?? []), f.row.part.def.name])]);
    }
    setList(null);
    meshes.meshesIn(files, (d, t) => !dead && setScan([d, t])).then((res) => {
      if (dead) return;
      const seen = new Set<string>();
      const out: MeshEntry[] = [];
      for (const { file, names } of res) {
        for (const n of names) {
          const k = n.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ name: n, file, usedBy: used.get(k) ?? [] });
        }
      }
      out.sort((a, b) => Number(a.usedBy.length > 0) - Number(b.usedBy.length > 0) || a.name.localeCompare(b.name));
      setList(out);
    });
    return () => {
      dead = true;
    };
  }, [model, withCommon, v]);

  const shown = (list ?? []).filter((m) => (!hideUsed || !m.usedBy.length) && (!q || m.name.toLowerCase().includes(q.toLowerCase())));

  // the picked mesh: geometry, then the group suggestion
  const [scores, setScores] = useState<GroupScore[]>([]);
  useEffect(() => {
    if (!mesh) return;
    let dead = false;
    setLoading(true);
    setGeo(null);
    meshes.load([mesh]).then(() => {
      if (dead) return;
      const g = meshes.get(mesh) ?? null;
      setGeo(g);
      setLoading(false);
      if (!g || !v) return;
      const own = new Set(v.nodes.filter((n) => n.row.part.def.name === partName).flatMap((n) => n.groups));
      const sc = scoreGroups(g.attributes.position.array as Float32Array, v.nodes.map((n) => ({ x: n.x, y: n.y, z: n.z, groups: n.groups })), own);
      setScores(sc);
      setGroups(new Set(sc.filter((s) => s.suggested).map((s) => s.group)));
    });
    return () => {
      dead = true;
    };
  }, [mesh, partName]);

  const allGroups = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of v?.nodes ?? []) for (const g of n.groups) c.set(g, (c.get(g) ?? 0) + 1);
    return c;
  }, [v]);
  const box = useMemo(() => {
    if (!geo) return null;
    geo.computeBoundingBox();
    const s = geo.boundingBox!.getSize(new THREE.Vector3());
    return { size: s, verts: geo.attributes.position.count, tris: Math.floor((geo.index?.count ?? geo.attributes.position.count) / 3) };
  }, [geo]);
  // nodes drawn in the preview: the chosen groups, and the others near the mesh for context
  const { selPts, othPts } = useMemo(() => {
    const sel: Array<[number, number, number]> = [];
    const oth: Array<[number, number, number]> = [];
    if (v && geo) {
      geo.computeBoundingBox();
      const bb = geo.boundingBox!.clone().expandByScalar(0.25);
      for (const n of v.nodes) {
        if (!bb.containsPoint(new THREE.Vector3(n.x, n.y, n.z))) continue;
        (n.groups.some((g) => groups.has(g)) ? sel : oth).push([n.x, n.y, n.z]);
      }
    }
    return { selPts: sel, othPts: oth };
  }, [v, geo, groups]);

  const scoreOf = new Map(scores.map((s) => [s.group, s]));
  const groupRows = [...allGroups.keys()]
    .filter((g) => !gq || g.toLowerCase().includes(gq.toLowerCase()))
    .sort((a, b) => (scoreOf.get(b)?.share ?? -1) - (scoreOf.get(a)?.share ?? -1) || a.localeCompare(b));
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setter(n);
  };
  const vec = (label: string, val: number[], set: (v: number[]) => void, step: number) => (
    <div className="tf-row">
      <span className="tf-label">{label}</span>
      {[0, 1, 2].map((i) => (
        <input key={i} className="input small mono tf-num" type="number" step={step} value={val[i]} onChange={(e) => set(val.map((x, j) => (j === i ? +e.target.value || 0 : x)))} />
      ))}
    </div>
  );

  const add = () => {
    if (!target || !mesh) return;
    if (!groups.size) return toast('warn', 'Pick at least one node group: the mesh follows the nodes of these groups');
    const header = headerOf(target.part, 'flexbodies');
    // mesh and groups only; offsets go in a trailing options object (never the column after groups)
    const cells: any[] = rowFromRecord(header, { mesh, '[group]:': [...groups] });
    const xyz = (a: number[]) => ({ x: a[0], y: a[1], z: a[2] });
    const opts: Record<string, any> = {};
    if (pos.some((x) => x)) opts.pos = xyz(pos);
    if (rot.some((x) => x)) opts.rot = xyz(rot);
    if (scale.some((x) => x !== 1)) opts.scale = xyz(scale);
    if (Object.keys(opts).length) cells.push(opts);
    const row = fmtRow(cells, 4);
    const es = new EditSet();
    es.add(target.doc.key, insertRowsHere(target.doc.text, target.part, 'flexbodies', header, [row]));
    if (!es.apply(`Add flexbody ${mesh}`)) return;
    toast('ok', `Added ${mesh} to ${target.part.name}`);
    close();
    setTimeout(() => {
      const fb = ws.vehicle?.flexbodies.find((f) => f.mesh === mesh && f.row.part.def.name === target.part.name);
      if (fb) revealRange(fb.row.src.file, fb.row.src.node.s, fb.row.src.node.e, true);
    }, 60);
  };

  return (
    <Modal title="Add flexbody" onClose={close} width={980} footer={<>
      <div className="row grow" style={{ gap: 8 }}>
        <span className="dim">Into</span>
        <select className="select small" value={partName} onChange={(e) => setPartName(e.target.value)}>
          {parts.map((p) => <option key={p.doc.key + p.part.name} value={p.part.name}>{p.part.name}</option>)}
        </select>
        {!parts.length && <span className="warn-text small-text">No editable part: make a file editable first</span>}
      </div>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!target || !mesh || !groups.size} onClick={add}>Add flexbody</button>
    </>}>
      <div className="fb-grid">
        <div className="fb-list-col">
          <div className="search-box" style={{ margin: 0 }}>
            <Search size={13} className="faint" />
            <input className="input small" autoFocus placeholder="Filter meshes" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <div className="fb-list-opts">
            <label className="disp-check"><input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} /> Hide meshes already used</label>
            <label className="disp-check"><input type="checkbox" checked={withCommon} onChange={(e) => setWithCommon(e.target.checked)} /> Include vehicles/common</label>
          </div>
          <div className="fb-list">
            {!list && <div className="faint small-text" style={{ padding: 8 }}>Reading meshes… {scan[1] ? `${scan[0]} / ${scan[1]} files` : ''}</div>}
            {list && !shown.length && <div className="faint small-text" style={{ padding: 8 }}>{list.length ? 'No match' : 'No .dae meshes in this vehicle'}</div>}
            {shown.slice(0, 500).map((m) => (
              <button key={m.name} className={'fb-item' + (m.name === mesh ? ' sel' : '')} onClick={() => setMesh(m.name)} title={`${m.name}\n${m.file.vpath}${m.usedBy.length ? '\nUsed by ' + m.usedBy.join(', ') : ''}`}>
                <Box size={13} className={m.usedBy.length ? 'faint' : 'part-icon'} />
                <span className="mono ellipsis grow">{m.name}</span>
                {m.usedBy.length > 0 && <span className="fb-used">used</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="fb-main-col">
          <MeshPreview geo={geo} loading={loading} selected={selPts} others={othPts} />
          {mesh && (
            <div className="fb-info small-text">
              <span className="mono strong">{mesh}</span>
              {box && <span className="faint"> · {box.size.x.toFixed(2)} × {box.size.y.toFixed(2)} × {box.size.z.toFixed(2)} m · {box.tris.toLocaleString()} triangles</span>}
              {list?.find((m) => m.name === mesh) && <span className="faint"> · {list.find((m) => m.name === mesh)!.file.vpath.split('/').pop()}</span>}
            </div>
          )}
          <div className="fb-cols">
            <div>
              <div className="fb-sub">
                Node groups
                {scores.length > 0 && (
                  <button className="btn small ghost" onClick={() => setGroups(new Set(scores.filter((s) => s.suggested).map((s) => s.group)))} data-tip="The groups whose nodes are nearest to the mesh" data-tip-pos="top"><Sparkles size={12} /> Suggested</button>
                )}
              </div>
              <input className="input small" placeholder="Filter groups" value={gq} onChange={(e) => setGq(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <div className="fb-groups">
                {groupRows.map((g) => {
                  const sc = scoreOf.get(g);
                  return (
                    <label key={g} className={'fb-group' + (sc?.suggested ? ' sug' : '')}>
                      <input type="checkbox" checked={groups.has(g)} onChange={() => toggle(groups, setGroups, g)} />
                      <span className="mono ellipsis grow">{g}</span>
                      {sc && <span className="fb-share" data-tip="Share of the mesh nearest to this group's nodes" data-tip-pos="left">{Math.round(sc.share * 100)}%</span>}
                      <span className="faint small-text">{allGroups.get(g)}n</span>
                    </label>
                  );
                })}
                {!groupRows.length && <div className="faint small-text">No node groups in this vehicle</div>}
              </div>
            </div>
            <div>
              <div className="fb-sub">Position, rotation, scale</div>
              <div className="col" style={{ gap: 4 }}>
                {vec('pos', pos, setPos, 0.01)}
                {vec('rot °', rot, setRot, 1)}
                {vec('scale', scale, setScale, 0.01)}
                <div className="faint small-text">Written only when changed. The preview shows the mesh where the .dae puts it.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

