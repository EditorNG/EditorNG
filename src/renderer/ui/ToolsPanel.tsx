import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Crosshair, MousePointerClick, Box, Lightbulb, Armchair, Zap, FileUp, Link2, Sparkles, Route } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, requestPick } from '../state/ui';
import { useSel, resolveSel, selNodeIdx } from '../state/selection';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { mirrorName, mirrorTrigger, targetPart, insertRowsHere, insertRawRows, addNodes, EditSet, addRail, addSlidenodes, snapToRails, selectNodesByName } from '../project/ops';
import { offRailSlides } from '@core/jbeam/rails';
import { getViewport, startRailSlide } from '../scene/ViewportPanel';
import { TRIGGER_ACTIONS, BULB_TYPES, LIGHT_ROLES, COMMON_ELECTRICS, type LightRole } from '@core/jbeam/docs';
import { swapSideTokens } from '@core/jbeam/mirror';
import {
  triggerRow, triggerLinkRows, needsActionsEnabled, bulbSlotRow, occupantSlotRow, rigidifierPosition, rigidifierBeams, legacyTriggerRow, legacyLinkRow, legacyEventRow,
  type V3,
} from '@core/jbeam/generators';
import { DEFAULT_HEADERS, fmtRow, insertKey, rowFromRecord } from '@core/jbeam/edit';
import type { AArr } from '@core/sjson';
import { getNodeXform, invertNodeXform } from '@core/jbeam/nodeTransform';
import { PanelHeader } from './SidePanels';
import { command } from './commands';

// ------------------------------------------------------------------------------------------
// small form helpers
// ------------------------------------------------------------------------------------------

function Section(props: { id?: string; icon: React.ReactNode; title: string; children: React.ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(!!props.open);
  const req = useUi((x) => x.toolReq);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (req && props.id && req.section === props.id) {
      setOpen(true);
      setTimeout(() => ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
    }
  }, [req?.seq]);
  return (
    <div ref={ref} className={'tool-section' + (open ? ' open' : '')}>
      <button className="tool-section-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {props.icon}
        <span>{props.title}</span>
      </button>
      {open && <div className="tool-section-body">{props.children}</div>}
    </div>
  );
}

function NodeField(props: { label: string; value: string; onChange: (v: string) => void }) {
  const exists = !props.value || ws.vehicle?.nodeIndex.has(props.value);
  return (
    <label className="tf-row">
      <span className="tf-label">{props.label}</span>
      <input className={'input small mono grow' + (exists ? '' : ' invalid')} value={props.value} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <button className="icon-btn small" data-tip="Click a node in 3D" data-tip-pos="left" onClick={async () => {
        const n = await requestPick(props.label);
        if (n) props.onChange(n);
      }} aria-label={`Pick ${props.label}`}><Crosshair size={13} /></button>
    </label>
  );
}

function VecField(props: { label: string; value: V3; onChange: (v: V3) => void; step?: number }) {
  const set = (k: keyof V3, x: string) => props.onChange({ ...props.value, [k]: parseFloat(x) || 0 });
  return (
    <div className="tf-row">
      <span className="tf-label">{props.label}</span>
      {(['x', 'y', 'z'] as const).map((k) => (
        <input key={k} className="input small mono tf-num" type="number" step={props.step ?? 0.005} value={+props.value[k].toFixed(4)} onChange={(e) => set(k, e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label={`${props.label} ${k}`} />
      ))}
    </div>
  );
}

function TextField(props: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; list?: string[]; placeholder?: string }) {
  const id = props.list ? 'dl-' + props.label.replace(/\W/g, '') : undefined;
  return (
    <label className="tf-row">
      <span className="tf-label">{props.label}</span>
      <input className={'input small grow' + (props.mono ? ' mono' : '')} value={props.value} list={id} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {props.list && <datalist id={id}>{props.list.map((x) => <option key={x} value={x} />)}</datalist>}
    </label>
  );
}

/** Applies an "Add" request (position / nodes) to a placer form. */
function useToolRequest(section: string, apply: (pos: V3 | undefined, nodes: string[]) => void) {
  const req = useUi((x) => x.toolReq);
  useEffect(() => {
    if (!req || req.section !== section) return;
    apply(req.pos ? { x: req.pos[0], y: req.pos[1], z: req.pos[2] } : undefined, req.nodes ?? []);
  }, [req?.seq]);
}

function selectionCentre(): V3 | null {
  const v = ws.vehicle;
  if (!v) return null;
  const idx = [...selNodeIdx(v, resolveSel(v, useSel.getState().sel))];
  if (!idx.length) return null;
  const c = { x: 0, y: 0, z: 0 };
  for (const i of idx) {
    c.x += v.nodes[i].x;
    c.y += v.nodes[i].y;
    c.z += v.nodes[i].z;
  }
  return { x: c.x / idx.length, y: c.y / idx.length, z: c.z / idx.length };
}

function selectedNames(): string[] {
  return [...useSel.getState().sel.nodes];
}

function nodePos(name: string): V3 | null {
  const v = ws.vehicle;
  const i = v?.nodeIndex.get(name);
  if (!v || i === undefined) return null;
  return { x: v.nodes[i].x, y: v.nodes[i].y, z: v.nodes[i].z };
}


function headerOf(part: ReturnType<typeof targetPart>, sec: string): string[] {
  const t = part?.part.sections.get(sec);
  if (t && t.k === 'arr' && t.items[0]?.k === 'arr') return (t.items[0] as AArr).items.map((x) => (x.k === 'str' ? x.v : ''));
  return DEFAULT_HEADERS[sec];
}

// ------------------------------------------------------------------------------------------

/** A dropdown of known values with an "Other…" entry that reveals a text box. */
function PickField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string; group?: string }>;
  none?: string;
  otherLabel?: string;
  placeholder?: string;
  tip?: string;
}) {
  const known = props.value === '' ? props.none !== undefined : props.options.some((o) => o.value === props.value);
  const [other, setOther] = useState(!known);
  const groups = new Map<string, typeof props.options>();
  for (const o of props.options) {
    const g = o.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  return (
    <>
      <label className="tf-row" data-tip={props.tip} data-tip-pos="right">
        <span className="tf-label">{props.label}</span>
        <select className="select small grow" value={other ? '\u0000other' : props.value} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => {
          const x = e.target.value;
          if (x === '\u0000other') {
            setOther(true);
            return;
          }
          setOther(false);
          props.onChange(x);
        }}>
          {props.none !== undefined && <option value="">{props.none}</option>}
          {[...groups].map(([g, list]) => (g ? (
            <optgroup key={g} label={g}>{list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
          ) : list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)))}
          <option value={'\u0000other'}>{props.otherLabel ?? 'Other…'}</option>
        </select>
      </label>
      {other && (
        <div className="tf-row">
          <span className="tf-label" />
          <input className="input small mono grow" autoFocus value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

const ACTION_OPTIONS = TRIGGER_ACTIONS.flatMap((g) => g.actions.map((a) => ({ value: a.id, label: a.label, group: g.group })));

/** Trigger action: every common / generic action of the game, or a custom one. */
function ActionField(props: { label: string; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const v = props.value;
  return (
    <>
      <PickField label={props.label} value={v} onChange={props.onChange} options={ACTION_OPTIONS} none={props.optional ? 'None' : undefined} otherLabel="Custom action…" placeholder="action id from <car>_default.interaction.json" />
      {v && (
        <div className="tf-hint">
          <span className="mono">{v}</span>
          {needsActionsEnabled(v) && <span data-tip={'Written to actionsEnabled too.\nGeneric actions need the matching coupler name (door_FR_coupler…);\ncustom ones must exist in the interaction file.'} data-tip-pos="top"> · actionsEnabled</span>}
        </div>
      )}
    </>
  );
}

function TriggerTool() {
  const [format, setFormat] = useState<'triggers2' | 'triggers'>('triggers2');
  const [id, setId] = useState('trigger_1');
  const [label, setLabel] = useState('Trigger');
  const [type, setType] = useState<'box' | 'sphere'>('sphere');
  const [ref, setRef] = useState(''), [nx, setNx] = useState(''), [ny, setNy] = useState('');
  const [pos, setPos] = useState<V3>({ x: 0, y: 0, z: 1 });
  const [size, setSize] = useState<V3>({ x: 0.02, y: 0.05, z: 0.05 });
  const [mesh, setMesh] = useState('');
  const [action, setAction] = useState('common:toggle_headlights');
  const [action2, setAction2] = useState('');
  const [event, setEvent] = useState('');
  const [onDown, setOnDown] = useState('');
  const legacy = format === 'triggers';
  useToolRequest('trigger', (p, n) => {
    if (p) setPos(p);
    if (n.length >= 3) {
      setRef(n[0]);
      setNx(n[1]);
      setNy(n[2]);
    }
  });
  const fromSel = () => {
    const n = selectedNames();
    if (n.length >= 3) {
      setRef(n[0]);
      setNx(n[1]);
      setNy(n[2]);
    } else toast('info', 'Select 3 nodes (ref, X, Y) in order');
    const c = selectionCentre();
    if (c) setPos(c);
  };
  const create = () => {
    const t = targetPart();
    if (!t) return toast('warn', 'No writable target part');
    if (![ref, nx, ny].every((n) => ws.vehicle?.nodeIndex.has(n))) return toast('warn', 'Reference nodes not found');
    if ((ws.vehicle?.triggers ?? []).some((r) => r.v.id === id)) return toast('warn', `Trigger id "${id}" already exists on this vehicle`);
    // the game applies the part's nodeOffset/nodeMove/nodeRotate to baseTranslationGlobal: write the raw value
    const raw = invertNodeXform(getNodeXform(t.active?.slotOptions ?? {}), pos.x, pos.y, pos.z);
    const spec = { id, idRef: ref, idX: nx, idY: ny, type, size, pos: { x: raw.x, y: raw.y, z: raw.z }, mesh: legacy ? undefined : mesh || undefined, action: action || undefined, action2: action2 || undefined };
    const es = new EditSet();
    const text = t.doc.text;
    let enable: string[] = [];
    if (legacy) {
      es.add(t.doc.key, insertRowsHere(text, t.part, 'triggers', headerOf(t, 'triggers'), [legacyTriggerRow({ ...spec, label })]));
      const ev = event.trim();
      if (ev) {
        es.add(t.doc.key, insertRowsHere(text, t.part, 'triggerEventLinks', headerOf(t, 'triggerEventLinks'), [legacyLinkRow(id, ev)]));
        const known = (ws.vehicle?.tables.get('events') ?? []).some((r) => r.v.id === ev);
        if (!known) es.add(t.doc.key, insertRowsHere(text, t.part, 'events', headerOf(t, 'events'), [legacyEventRow(ev, label, onDown)]));
      }
    } else {
      es.add(t.doc.key, insertRowsHere(text, t.part, 'triggers2', headerOf(t, 'triggers2'), [triggerRow(spec)]));
      const links = triggerLinkRows(spec);
      if (links.length) es.add(t.doc.key, insertRowsHere(text, t.part, 'triggerEventLinks2', headerOf(t, 'triggerEventLinks2'), links));
      const have = new Set((ws.vehicle?.tables.get('actionsEnabled') ?? []).filter((r) => r.part.def.name === t.part.name).map((r) => String(r.v.id)));
      enable = [...new Set([action, action2].filter((a) => needsActionsEnabled(a) && !have.has(a)))];
      if (enable.length) es.add(t.doc.key, insertRowsHere(text, t.part, 'actionsEnabled', headerOf(t, 'actionsEnabled'), enable.map((a) => fmtRow([a]))));
    }
    const sym = settings().symmetryX;
    const added = ws.group(`Add trigger ${id}${sym ? ' (symmetry)' : ''}`, () => {
      if (!es.apply(`Add trigger ${id}`)) return false;
      // symmetry: its mirror on the other side too (unless it sits on the centre line)
      const v = ws.vehicle;
      const i = v ? v.triggers.findIndex((r) => r.v.id === id) : -1;
      if (sym && i >= 0 && ![ref, nx, ny].every((n) => mirrorName(n) === null)) mirrorTrigger(i);
      return true;
    });
    if (added) {
      toast('ok', `Trigger ${id} added${enable.length ? ' (+ actionsEnabled)' : ''}`);
      setId(id.replace(/\d+$/, (m) => String(+m + 1)));
    }
  };
  return (
    <>
      <div className="tf-row">
        <span className="tf-label">format</span>
        <div className="segmented small grow">
          <button className={'seg grow' + (!legacy ? ' active' : '')} onClick={() => setFormat('triggers2')} data-tip="Current format: common / generic / custom actions">triggers2</button>
          <button className={'seg grow' + (legacy ? ' active' : '')} onClick={() => setFormat('triggers')} data-tip="Old format: label + an event running Lua">triggers</button>
        </div>
      </div>
      <TextField label="id" value={id} onChange={setId} mono />
      {legacy && <TextField label="label" value={label} onChange={setLabel} />}
      <div className="tf-row">
        <span className="tf-label">shape</span>
        <div className="segmented small">
          <button className={'seg' + (type === 'sphere' ? ' active' : '')} onClick={() => setType('sphere')}>sphere</button>
          <button className={'seg' + (type === 'box' ? ' active' : '')} onClick={() => setType('box')}>box</button>
        </div>
      </div>
      <NodeField label="idRef" value={ref} onChange={setRef} />
      <NodeField label="idX" value={nx} onChange={setNx} />
      <NodeField label="idY" value={ny} onChange={setNy} />
      <VecField label={type === 'box' ? 'corner' : 'centre'} value={pos} onChange={setPos} />
      {type === 'sphere' ? (
        <label className="tf-row"><span className="tf-label">radius</span><input className="input small mono tf-num" type="number" step={0.005} value={size.x} onChange={(e) => setSize({ ...size, x: +e.target.value })} onKeyDown={(e) => e.stopPropagation()} /></label>
      ) : (
        <VecField label="size" value={size} onChange={setSize} />
      )}
      {!legacy && <TextField label="mesh" value={mesh} onChange={setMesh} mono placeholder="highlight mesh (optional)" />}
      {legacy ? (
        <>
          <TextField label="event" value={event} onChange={setEvent} mono placeholder="event id (optional)" />
          {event.trim() && !(ws.vehicle?.tables.get('events') ?? []).some((r) => r.v.id === event.trim()) && (
            <TextField label="onDown" value={onDown} onChange={setOnDown} mono placeholder="Lua run on click" />
          )}
        </>
      ) : (
        <>
          <ActionField label="action0" value={action} onChange={setAction} />
          <ActionField label="action2" value={action2} onChange={setAction2} optional />
        </>
      )}
      <div className="tf-actions">
        <button className="btn small" onClick={fromSel}><MousePointerClick size={12} /> From selection</button>
        <button className="btn small primary" onClick={create}>Add trigger</button>
      </div>
      <div className="tf-note">Select 3 nodes in order (ref, X, Y), then From selection. Box: X = ref→idX, Z = ref→idY, size.y is the height.</div>
    </>
  );
}

// ------------------------------------------------------------------------------------------

type Side = 'L' | 'R' | 'C';
const SIDE_WORD: Record<Side, string> = { L: 'Left', R: 'Right', C: '' };

/** Bulb rotation for a side: roles are written for the left (+X) side, the right one is mirrored. */
function roleRot(role: LightRole, side: Side): V3 {
  if (side !== 'R') return { ...role.rot };
  let z = -role.rot.z;
  if (z < 0) z += 360;
  return { x: role.rot.x, y: role.rot.y, z };
}

function mirrorRot(r: V3): V3 {
  let z = -r.z;
  if (z < 0) z += 360;
  return { x: r.x, y: r.y, z };
}

/** electrics values used by the vehicle's bulb slots, plus the usual ones */
function knownElectrics(): string[] {
  const out = new Set(COMMON_ELECTRICS);
  // the vehicle's own electrics: customValues rows ["name", "...electrics.x..."] in its files
  for (const d of ws.docs.values()) {
    if (d.isCommon || d.lang !== 'jbeam') continue;
    for (const m of d.text.matchAll(/\[\s*"([A-Za-z_]\w*)"\s*,\s*"[^"\n]*electrics\./g)) out.add(m[1]);
  }
  for (const p of ws.vehicle?.parts ?? []) {
    for (const s of p.def.slots) {
      const e = s.variables?.$electric ?? s.options?.variables?.$electric;
      if (typeof e === 'string' && e) out.add(e);
    }
  }
  return [...out];
}

function knownDeformGroups(): string[] {
  const out = new Set<string>();
  for (const b of ws.vehicle?.beams ?? []) {
    const g = b.row.v.deformGroup;
    if (typeof g === 'string' && g) out.add(g);
  }
  return [...out].sort();
}

/** 3 nodes nearest to a point (for the bulb's reference frame) */
function nearestNodes(p: V3): string[] {
  const v = ws.vehicle;
  if (!v) return [];
  return v.nodes
    .map((n) => ({ n: n.name, d: Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((o) => o.n);
}

function LightTool() {
  const [roleId, setRoleId] = useState(LIGHT_ROLES[0].id);
  const role = LIGHT_ROLES.find((r) => r.id === roleId)!;
  const [sideSel, setSideSel] = useState<'auto' | Side>('auto');
  const [pos, setPos] = useState<V3>({ x: 0.6, y: -2, z: 0.6 });
  const [ref, setRef] = useState(''), [nx, setNx] = useState(''), [ny, setNy] = useState('');
  const [dg, setDg] = useState('');
  const [both, setBoth] = useState(true);
  const [rotOv, setRotOv] = useState<V3 | null>(null);
  const [elecOv, setElecOv] = useState<string | null>(null);
  const [bulbOv, setBulbOv] = useState<string | null>(null);
  const [nameOv, setNameOv] = useState<string | null>(null);
  const [shadow, setShadow] = useState(true);
  const [pattern, setPattern] = useState('');
  const [short, setShort] = useState<boolean | null>(null);
  const [more, setMore] = useState(false);
  useWs((x) => x.version);
  const tol = settings().namingCenterTolerance;
  const side: Side = sideSel !== 'auto' ? sideSel : pos.x > tol ? 'L' : pos.x < -tol ? 'R' : 'C';
  const rot = rotOv ?? roleRot(role, side);
  const sideElec = (e: string, s: Side) => (s === 'R' ? e.replace(/_L$/, '_R') : s === 'L' ? e.replace(/_R$/, '_L') : e);
  const electric = elecOv ?? sideElec(role.electric, side);
  const bulb = bulbOv ?? role.bulb;
  const isShort = short ?? !!role.small;
  const prefix = (ws.model ?? targetPart()?.part.name.split('_')[0] ?? 'car').toLowerCase();
  const autoName = (s: Side) => `${prefix}_${role.token}${s === 'C' ? '' : '_' + s}_bulb`;
  const slotName = (s: Side) => (nameOv !== null && s === side ? nameOv : nameOv !== null ? swapSideTokens(nameOv) : autoName(s));
  const descOf = (s: Side) => {
    const d = `${SIDE_WORD[s]} ${role.desc} bulb`.trim();
    return d.charAt(0).toUpperCase() + d.slice(1);
  };
  const mirrored = both && side !== 'C';
  const pickRole = (id: string) => {
    setRoleId(id);
    setRotOv(null);
    setElecOv(null);
    setBulbOv(null);
    setNameOv(null);
    setShort(null);
    const r = LIGHT_ROLES.find((x) => x.id === id)!;
    if (r.centre) setBoth(false);
    else setBoth(true);
  };
  useToolRequest('bulb', (p, n) => {
    if (p) setPos(p);
    if (n.length >= 3) {
      setRef(n[0]);
      setNx(n[1]);
      setNy(n[2]);
    } else if (p) {
      const nn = nearestNodes(p);
      if (nn.length === 3) [setRef, setNx, setNy].forEach((f, i) => f(nn[i]));
    }
  });
  const fromSel = () => {
    const n = selectedNames();
    if (n.length >= 3) {
      setRef(n[0]);
      setNx(n[1]);
      setNy(n[2]);
    }
    const c = selectionCentre();
    if (c) setPos(c);
    if (!c) toast('info', 'Select the lamp housing nodes first');
  };
  const pickPos = async () => {
    const n = await requestPick('light position');
    const p = n ? nodePos(n) : null;
    if (!p) return;
    setPos(p);
    if (!ref) {
      const nn = nearestNodes(p);
      if (nn.length === 3) [setRef, setNx, setNy].forEach((f, i) => f(nn[i]));
    }
  };
  const extras = (s: Side): Record<string, string | number> => {
    const e: Record<string, string | number> = {};
    if (role.pattern && pattern) e.$lightPattern = pattern;
    if (isShort) {
      e.$lightInnerAngle = 0;
      e.$lightOuterAngle = role.id === 'plate' ? 120 : 170;
      e.$lightRange = 1;
      e.$flareScale = 0;
    }
    void s;
    return e;
  };
  const create = () => {
    const t = targetPart();
    if (!t) return toast('warn', 'No writable target part');
    if (![ref, nx, ny].every((n) => ws.vehicle?.nodeIndex.has(n))) return toast('warn', 'Pick the 3 lamp nodes (the bulb follows them)');
    const rows: string[] = [];
    const names: string[] = [];
    const add = (s: Side, p: V3, r: V3, nodes: string[], group: string, elec: string) => {
      const name = slotName(s);
      if (findSlot(name) || names.includes(name)) {
        toast('warn', `Slot "${name}" already exists`);
        return false;
      }
      names.push(name);
      rows.push(bulbSlotRow({ slotName: name, bulb, description: descOf(s), electric: elec, nodeRef: nodes[0], nodeX: nodes[1], nodeY: nodes[2], deformGroup: group, pos: p, rot: r, shadow, extra: extras(s) }));
      return true;
    };
    if (!add(side, pos, rot, [ref, nx, ny], dg, electric)) return;
    if (mirrored) {
      const os: Side = side === 'L' ? 'R' : 'L';
      const mn = [ref, nx, ny].map((n) => mirrorName(n) ?? n);
      if (!mn.every((n) => ws.vehicle?.nodeIndex.has(n))) return toast('warn', `Mirror nodes not found (${mn.join(', ')}); untick "Both sides"`);
      if (!add(os, { ...pos, x: -pos.x }, mirrorRot(rot), mn, dg ? swapSideTokens(dg) : '', sideElec(electric, os))) return;
    }
    if (t.part.sections.has('slots') && !t.part.sections.has('slots2')) toast('warn', 'This part uses old "slots"; the game ignores slots2 when slots exists. Convert it first.');
    const es = new EditSet();
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'slots2', headerOf(t, 'slots2'), rows));
    if (es.apply(`Add ${role.label.toLowerCase()} light`)) toast('ok', `Added ${names.join(' + ')}`);
  };
  const dirBtn = (label: string, r: V3, tip: string) => {
    const on = Math.abs(rot.x - r.x) < 0.01 && Math.abs(((rot.z - r.z) % 360 + 360) % 360) < 0.01;
    return <button className={'seg' + (on ? ' active' : '')} data-tip={tip} onClick={() => setRotOv(r)}>{label}</button>;
  };
  const outward: V3 = side === 'R' ? { x: 0, y: 0, z: 270 } : { x: 0, y: 0, z: -270 };
  const deformGroups = knownDeformGroups();
  return (
    <>
      <div className="light-roles">
        {LIGHT_ROLES.map((r) => (
          <button key={r.id} className={'light-role' + (r.id === roleId ? ' on' : '')} onClick={() => pickRole(r.id)}>{r.label}</button>
        ))}
      </div>
      <div className="tf-sub row">Where<div className="grow" /><button className="icon-btn small" data-tip="Take the position of a node clicked in 3D" data-tip-pos="left" onClick={pickPos} aria-label="Pick position"><Crosshair size={13} /></button></div>
      <VecField label="position" value={pos} onChange={setPos} />
      <div className="segmented small" style={{ width: '100%' }}>
        {(['auto', 'L', 'R', 'C'] as const).map((s) => (
          <button key={s} className={'seg' + (sideSel === s ? ' active' : '')} onClick={() => setSideSel(s)} data-tip={s === 'auto' ? 'Side from the position: +X left, −X right' : undefined}>
            {s === 'auto' ? `Auto · ${SIDE_WORD[side] || 'Centre'}` : s === 'C' ? 'Centre' : s === 'L' ? 'Left' : 'Right'}
          </button>
        ))}
      </div>
      {side !== 'C' && (
        <label className="tf-row"><span className="tf-label">both sides</span><button className={'switch' + (both ? ' on' : '')} onClick={() => setBoth(!both)} aria-label="Both sides" /><span className="faint small-text">mirrored at x = {fmtN(-pos.x)}</span></label>
      )}
      <NodeField label="$nodeRef" value={ref} onChange={setRef} />
      <NodeField label="$nodeX" value={nx} onChange={setNx} />
      <NodeField label="$nodeY" value={ny} onChange={setNy} />
      <div className="tf-sub">Direction</div>
      <div className="segmented small" style={{ width: '100%' }}>
        <>
          {dirBtn('Forward', { x: 0, y: 0, z: 180 }, 'rotZ 180')}
          {dirBtn('Back', { x: 0, y: 0, z: 0 }, 'rotZ 0')}
          {dirBtn('Out', outward, 'Side marker: out of the car')}
          {dirBtn('Down', { x: 90, y: 0, z: 0 }, 'rotX 90: dome, trunk, footwell')}
        </>
      </div>
      <VecField label="rotation" value={rot} onChange={setRotOv} step={5} />
      <div className="tf-sub">Behaviour</div>
      <PickField label="electrics" value={electric} onChange={setElecOv} options={knownElectrics().map((e) => ({ value: e, label: e }))} tip="The electrics value that drives the bulb (0..1)" placeholder="electrics value" />
      <PickField label="breaks with" value={dg} onChange={setDg} options={deformGroups.map((g) => ({ value: g, label: g }))} none="Never breaks" tip="deformGroup: the bulb dies when it breaks" placeholder="deformGroup" />
      {role.pattern && (
        <label className="tf-row"><span className="tf-label">pattern</span>
          <div className="segmented small grow">
            {([['', 'Std'], ['LHD', 'LHD'], ['RHD', 'RHD'], ['US', 'US']] as const).map(([v, l]) => (
              <button key={v} className={'seg' + (pattern === v ? ' active' : '')} onClick={() => setPattern(v)} data-tip={v ? `$lightPattern ${v}` : 'Default beam pattern'} data-tip-pos="top">{l}</button>
            ))}
          </div>
        </label>
      )}
      <button className="tf-more" onClick={() => setMore(!more)}>{more ? <ChevronDown size={12} /> : <ChevronRight size={12} />} More</button>
      {more && (
        <>
          <label className="tf-row">
            <span className="tf-label">bulb</span>
            <select className="select small grow" value={bulb} onChange={(e) => setBulbOv(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
              {BULB_TYPES.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}
            </select>
          </label>
          <label className="tf-row"><span className="tf-label">shadows</span><button className={'switch' + (shadow ? ' on' : '')} onClick={() => setShadow(!shadow)} aria-label="Shadows" /></label>
          <label className="tf-row"><span className="tf-label">short range</span><button className={'switch' + (isShort ? ' on' : '')} onClick={() => setShort(!isShort)} aria-label="Short range" /><span className="faint small-text">1 m, wide cone, no flare</span></label>
          <TextField label="slot name" value={slotName(side)} onChange={setNameOv} mono />
        </>
      )}
      <div className="light-preview">
        {[side, ...(mirrored ? [side === 'L' ? 'R' : 'L'] as Side[] : [])].map((s) => (
          <div key={s} className="light-preview-row">
            <span className="mono ellipsis">{slotName(s)}</span>
            <span className="faint ellipsis">{descOf(s)}</span>
          </div>
        ))}
      </div>
      <div className="tf-actions">
        <button className="btn small" onClick={fromSel}><MousePointerClick size={12} /> From selection</button>
        <button className="btn small primary" onClick={create}>{mirrored ? 'Add both lights' : 'Add light'}</button>
      </div>
    </>
  );
}

const fmtN = (x: number) => String(+x.toFixed(4));

function findSlot(name: string): boolean {
  for (const p of ws.vehicle?.parts ?? []) if (p.def.slots.some((s) => s.name === name)) return true;
  return false;
}

// ------------------------------------------------------------------------------------------

function OccupantTool() {
  const [seatID, setSeatID] = useState('FL');
  const [mesh, setMesh] = useState('');
  const [att, setAtt] = useState({ FL: '', FR: '', RL: '', RR: '', TL: '', TR: '' });
  const [rig, setRig] = useState('sf4l');
  const [move, setMove] = useState<V3>({ x: 0.4, y: 0.08, z: 0.46 });
  const [recline, setRecline] = useState(-24);
  const [makeRig, setMakeRig] = useState(true);
  const [noSelfCol, setNoSelfCol] = useState(false);
  const setA = (k: keyof typeof att) => (v: string) => setAtt({ ...att, [k]: v });
  useToolRequest('occupant', (_p, n) => {
    if (n.length >= 6) setAtt({ FL: n[0], FR: n[1], RL: n[2], RR: n[3], TL: n[4], TR: n[5] });
  });
  const fromSel = () => {
    const n = selectedNames();
    if (n.length < 6) return toast('info', 'Select 6 seat nodes in order: cushion FL, FR, RL, RR, backrest TL, TR (occupant left = car +X)');
    setAtt({ FL: n[0], FR: n[1], RL: n[2], RR: n[3], TL: n[4], TR: n[5] });
    autoMove({ FL: n[0], FR: n[1], RL: n[2], RR: n[3], TL: n[4], TR: n[5] });
  };
  const autoMove = (a = att) => {
    const P = (k: keyof typeof att) => nodePos(a[k]);
    const pts = (['FL', 'FR', 'RL', 'RR', 'TL', 'TR'] as const).map(P);
    if (pts.some((p) => !p)) return;
    const [fl, fr, rl, rr, tl, tr] = pts as V3[];
    // hip point: middle of the cushion rear, slightly forward; recline from backrest angle
    setMove({ x: (fl.x + fr.x + rl.x + rr.x) / 4, y: (rl.y + rr.y) / 2 - 0.02, z: (rl.z + rr.z) / 2 + 0.03 });
    const by = (tl.y + tr.y) / 2 - (rl.y + rr.y) / 2;
    const bz = (tl.z + tr.z) / 2 - (rl.z + rr.z) / 2;
    const ang = (Math.atan2(by, bz) * 180) / Math.PI;
    setRecline(-Math.round(Math.abs(ang)));
  };
  const create = () => {
    const t = targetPart();
    if (!t) return toast('warn', 'No writable target part');
    const keys = Object.keys(att) as Array<keyof typeof att>;
    if (keys.some((k) => !ws.vehicle?.nodeIndex.has(att[k]))) return toast('warn', 'All 6 attach nodes must exist');
    const slotName = `seat_occupant_${seatID}`;
    if (findSlot(slotName)) return toast('warn', `${slotName} already exists`);
    const es = new EditSet();
    const text = t.doc.text;
    es.add(t.doc.key, insertRowsHere(text, t.part, 'slots2', headerOf(t, 'slots2'), [occupantSlotRow({
      slotName, description: `${seatID} Seat Occupant`, seatID, highlightMesh: mesh, nodeMove: move, recline, attach: att, rigidifier: rig, dragCoef: 1, noSelfCol,
    })]));
    if (makeRig && !ws.vehicle?.nodeIndex.has(rig)) {
      const pos = rigidifierPosition(Object.fromEntries(keys.map((k) => [k, nodePos(att[k])!])) as any);
      const h = headerOf(t, 'nodes');
      const dec = settings().decimals;
      const r = (x: number) => Math.round(x * 10 ** dec) / 10 ** dec;
      es.add(t.doc.key, insertRowsHere(text, t.part, 'nodes', h, [fmtRow(rowFromRecord(h, { id: rig, posX: r(pos.x), posY: r(pos.y), posZ: r(pos.z), collision: false, selfCollision: false, group: '', nodeWeight: 1 }), dec)]));
      es.add(t.doc.key, insertRowsHere(text, t.part, 'beams', headerOf(t, 'beams'), rigidifierBeams(rig, att)));
    }
    if (es.apply(`Add occupant ${seatID}`)) {
      toast('ok', `Occupant ${seatID} added`);
      checkOccupantSystem();
    }
  };
  return (
    <>
      <label className="tf-row">
        <span className="tf-label">$seatID</span>
        <select className="select small grow" value={seatID} onChange={(e) => setSeatID(e.target.value)}>
          {['FL', 'FR', 'RL', 'RR', 'RM', 'FM', 'R2L', 'R2R'].map((x) => <option key={x}>{x}</option>)}
        </select>
      </label>
      <NodeField label="attach FL" value={att.FL} onChange={setA('FL')} />
      <NodeField label="attach FR" value={att.FR} onChange={setA('FR')} />
      <NodeField label="attach RL" value={att.RL} onChange={setA('RL')} />
      <NodeField label="attach RR" value={att.RR} onChange={setA('RR')} />
      <NodeField label="attach TL" value={att.TL} onChange={setA('TL')} />
      <NodeField label="attach TR" value={att.TR} onChange={setA('TR')} />
      <TextField label="rigidifier" value={rig} onChange={setRig} mono />
      <label className="tf-row"><span className="tf-label">create it</span><button className={'switch' + (makeRig ? ' on' : '')} onClick={() => setMakeRig(!makeRig)} aria-label="Create rigidifier" /> <span className="faint small-text">node + 4 beams</span></label>
      <VecField label="nodeMove" value={move} onChange={setMove} />
      <label className="tf-row"><span className="tf-label">recline °</span><input className="input small mono tf-num" type="number" value={recline} onChange={(e) => setRecline(+e.target.value)} onKeyDown={(e) => e.stopPropagation()} /><span className="faint small-text">camPitch = {-recline}</span></label>
      <TextField label="highlight" value={mesh} onChange={setMesh} mono placeholder="seat mesh (optional)" />
      <label className="tf-row"><span className="tf-label">no self-col</span><button className={'switch' + (noSelfCol ? ' on' : '')} onClick={() => setNoSelfCol(!noSelfCol)} aria-label="Disable lower torso self collision" /> <span className="faint small-text">rear benches / race seats</span></label>
      <div className="tf-actions">
        <button className="btn small" onClick={fromSel}><MousePointerClick size={12} /> From selection</button>
        <button className="btn small" onClick={() => autoMove()}>Estimate pose</button>
        <button className="btn small primary" onClick={create}>Add occupant</button>
      </div>
      <div className="tf-note">Occupant left = car +X: on the left seat FL is the outer (+X) node, on the right seat FL is the inner one. Mark the driver with <span className="mono">"$isDriver":"LHD"</span> on the parent seat slot. Keep occupant nodes ≥ 2.5 cm from seat collision triangles.</div>
    </>
  );
}

function checkOccupantSystem() {
  const v = ws.vehicle;
  if (!v?.root) return;
  if (v.root.def.sections.has('occupantSystem')) return;
  toast('warn', 'The main part has no occupantSystem section', {
    label: 'Add it',
    run: () => {
      const d = ws.doc(v.root.def.file);
      if (!d?.writable) return toast('warn', 'Main part file is read-only');
      const es = new EditSet();
      es.add(d.key, insertKey(d.text, v.root.def.node, 'occupantSystem', () => '{ "enabled": true, "version": 1 }'));
      es.apply('Enable occupant system');
    },
  });
}

// ------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------

function NodeTool() {
  const [prefix, setPrefix] = useState('n');
  const [count, setCount] = useState(5);
  const [mirrorIt, setMirror] = useState(true);
  return (
    <>
      <div className="tf-note" style={{ marginTop: 0 }}>Fill the space between 2 selected nodes with evenly spaced nodes (e.g. a rail or roof bow).</div>
      <TextField label="prefix" value={prefix} onChange={setPrefix} mono />
      <label className="tf-row"><span className="tf-label">count</span><input className="input small mono tf-num" type="number" min={1} value={count} onChange={(e) => setCount(Math.max(1, +e.target.value | 0))} onKeyDown={(e) => e.stopPropagation()} /></label>
      <label className="tf-row"><span className="tf-label">also mirror</span><button className={'switch' + (mirrorIt ? ' on' : '')} onClick={() => setMirror(!mirrorIt)} aria-label="Mirror" /></label>
      <div className="tf-actions">
        <button className="btn small primary" onClick={() => {
          const n = selectedNames();
          if (n.length !== 2) return toast('info', 'Select exactly 2 nodes');
          const a = nodePos(n[0])!, b = nodePos(n[1])!;
          const v = ws.vehicle!;
          const taken = new Set(v.nodeIndex.keys());
          const out: Array<{ name: string; x: number; y: number; z: number }> = [];
          let num = settings().namingStart;
          const side = (x: number) => (x > settings().namingCenterTolerance ? settings().mirrorSuffixLeft : x < -settings().namingCenterTolerance ? settings().mirrorSuffixRight : '');
          for (let i = 1; i <= count; i++) {
            const t = i / (count + 1);
            const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
            let name: string;
            do name = prefix + num++ + side(p.x);
            while (taken.has(name));
            taken.add(name);
            out.push({ name, ...p });
            if (mirrorIt && Math.abs(p.x) > settings().namingCenterTolerance) {
              const mn = name.slice(0, -side(p.x).length) + side(-p.x);
              if (!taken.has(mn)) {
                taken.add(mn);
                out.push({ name: mn, x: -p.x, y: p.y, z: p.z });
              }
            }
          }
          addNodes(out, 'Subdivide');
        }}><Sparkles size={12} /> Create nodes</button>
      </div>
    </>
  );
}


// ------------------------------------------------------------------------------------------

/** Orders nodes along a path: start at the end farthest from the centre, then nearest neighbour. */
function orderAlongPath(names: string[]): string[] {
  const pts = names.map((n) => ({ n, p: nodePos(n)! })).filter((o) => o.p);
  if (pts.length < 3) return pts.map((o) => o.n);
  const c = pts.reduce((a, o) => ({ x: a.x + o.p.x / pts.length, y: a.y + o.p.y / pts.length, z: a.z + o.p.z / pts.length }), { x: 0, y: 0, z: 0 });
  const d = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  let cur = pts.reduce((a, o) => (d(o.p, c) > d(a.p, c) ? o : a));
  const out = [cur];
  const left = new Set(pts.filter((o) => o !== cur));
  while (left.size) {
    let best: typeof cur | null = null;
    for (const o of left) if (!best || d(o.p, cur.p) < d(best.p, cur.p)) best = o;
    left.delete(best!);
    out.push(best!);
    cur = best!;
  }
  return out.map((o) => o.n);
}

function RailTool() {
  useSel((x) => x.sel);
  const vp = getViewport();
  const v = ws.vehicle;
  const rails = vp ? [...vp.rails.values()] : [];
  const slides = vp?.slides ?? [];
  const [name, setName] = useState('rail_1');
  const [looped, setLooped] = useState(false);
  const [capped, setCapped] = useState(true);
  const [sortPath, setSortPath] = useState(true);
  const [rail, setRail] = useState('');
  const [spring, setSpring] = useState(800100);
  const [snap, setSnap] = useState(true);
  useToolRequest('rail', () => {});
  const railName = rail || rails[0]?.name || '';
  const off = v ? new Map(offRailSlides(v).map((o) => [o.slide.node, o.dist])) : new Map<number, number>();
  const selectNodes = (idx: number[]) => v && selectNodesByName(idx.map((i) => v.nodes[i].name));
  return (
    <>
      <div className="tf-sub">New rail</div>
      <TextField label="name" value={name} onChange={setName} mono />
      <label className="tf-row"><span className="tf-label">looped</span><button className={'switch' + (looped ? ' on' : '')} onClick={() => setLooped(!looped)} aria-label="Looped" /></label>
      <label className="tf-row"><span className="tf-label">capped</span><button className={'switch' + (capped ? ' on' : '')} onClick={() => setCapped(!capped)} aria-label="Capped" /></label>
      <label className="tf-row"><span className="tf-label">order by path</span><button className={'switch' + (sortPath ? ' on' : '')} onClick={() => setSortPath(!sortPath)} aria-label="Order along path" /></label>
      <div className="tf-actions">
        <button className="btn small primary" onClick={() => {
          const n = selectedNames();
          if (n.length < 2) return toast('info', 'Select 2 or more nodes (in rail order, or turn on "order by path")');
          if (addRail(name, sortPath ? orderAlongPath(n) : n, looped, capped)) {
            setRail(name.trim());
            setName(name.replace(/\d+$/, (d) => String(+d + 1)));
          }
        }}><Route size={12} /> Rail from selection</button>
      </div>
      <div className="tf-sub">Slidenodes</div>
      <label className="tf-row">
        <span className="tf-label">rail</span>
        <select className="select small mono grow" value={railName} onChange={(e) => setRail(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
          {rails.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          {!rails.length && <option value="">no rails yet</option>}
        </select>
      </label>
      <label className="tf-row"><span className="tf-label">spring</span><input className="input small mono tf-num grow" type="number" value={spring} onChange={(e) => setSpring(+e.target.value || 0)} onKeyDown={(e) => e.stopPropagation()} /></label>
      <label className="tf-row"><span className="tf-label">snap onto rail</span><button className={'switch' + (snap ? ' on' : '')} onClick={() => setSnap(!snap)} aria-label="Snap onto rail" /></label>
      <div className="tf-actions">
        <button className="btn small primary" disabled={!railName} onClick={() => {
          const r = vp?.rails.get(railName);
          const own = new Set(r ? r.nodes.map((i) => v!.nodes[i].name) : []);
          const n = selectedNames().filter((x) => !own.has(x));
          if (!n.length) return toast('info', 'Select the nodes that should slide (not the rail nodes)');
          addSlidenodes(n, railName, snap, spring);
        }}>Make selected slidenodes</button>
        <button className="btn small" onClick={() => startRailSlide()} data-tip="G G in the viewport">Slide</button>
      </div>
      <div className="tf-note">Move a slidenode along its rail with <b>G G</b> (like Blender's edge slide): drag, type metres, Ctrl snaps to a pointed node, Alt uses increments.</div>
      {rails.length > 0 && (
        <>
          <div className="tf-sub">Rails in vehicle ({rails.length})</div>
          <div className="rail-list">
            {rails.map((r) => {
              const sl = slides.filter((s) => s.rail === r.name);
              const bad = sl.filter((s) => off.has(s.node));
              return (
                <div key={r.name} className="rail-item">
                  <button className="rl-btn mono ellipsis" onClick={() => selectNodes(r.nodes)} data-tip={'Select the rail nodes\n' + r.part.def.name}>{r.name}</button>
                  <span className="faint small-text">{r.nodes.length}n{r.looped ? ' ⟲' : ''}</span>
                  <button className="rl-btn small-text" disabled={!sl.length} onClick={() => selectNodes(sl.map((s) => s.node))} data-tip="Select its slidenodes">{sl.length} slide</button>
                  {bad.length > 0 && <span className="warn-text small-text" data-tip={bad.map((s) => `${v!.nodes[s.node].name}: ${(off.get(s.node)! * 1000).toFixed(1)} mm off`).join('\n')}>{bad.length} off</span>}
                  {r.missing.length > 0 && <span className="warn-text small-text" data-tip={'Unknown nodes: ' + r.missing.join(', ')}>missing</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------

export function ToolsPanel() {
  useWs((x) => x.version);
  return (
    <div className="panel">
      <PanelHeader title="Create & place" />
      <div className="panel-scroll tools">
        <Section icon={<FileUp size={14} />} title="Import from Blender / OBJ" open>
          <div className="tf-actions" style={{ marginTop: 0 }}>
            <button className="btn small" onClick={() => command('tools.importMesh')}><FileUp size={12} /> Import…</button>
            <button className="btn small" onClick={() => command('tools.blenderAddon')}><Link2 size={12} /> Live link</button>
          </div>
          <div className="tf-note">Vertices → nodes, edges → beams, faces → collision triangles. Names get l/r suffixes by side and re-imports keep existing names.</div>
        </Section>
        <Section id="trigger" icon={<Zap size={14} />} title="Triggers"><TriggerTool /></Section>
        <Section id="bulb" icon={<Lightbulb size={14} />} title="Lights"><LightTool /></Section>
        <Section id="occupant" icon={<Armchair size={14} />} title="Occupant"><OccupantTool /></Section>
        <Section id="rail" icon={<Route size={14} />} title="Rails & slidenodes"><RailTool /></Section>
        <Section id="subdivide" icon={<Box size={14} />} title="Subdivide between nodes"><NodeTool /></Section>
      </div>
    </div>
  );
}

export { useUi };
