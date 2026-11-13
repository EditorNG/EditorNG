import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Crosshair, MousePointerClick, Box, Lightbulb, Armchair, CircleDot, Zap, FileUp, Link2, Target, Sparkles, Route } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, requestPick } from '../state/ui';
import { useSel, resolveSel, selNodeIdx } from '../state/selection';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { targetPart, insertRowsHere, insertRawRows, addNodes, EditSet, addRail, addSlidenodes, snapToRails, selectNodesByName } from '../project/ops';
import { offRailSlides } from '@core/jbeam/rails';
import { getViewport, startRailSlide } from '../scene/ViewportPanel';
import { COMMON_ACTIONS, GENERIC_ACTIONS, BULB_TYPES } from '@core/jbeam/docs';
import {
  triggerRow, triggerLinkRows, needsActionsEnabled, bulbSlotRow, BULB_ROT_PRESETS, occupantSlotRow, rigidifierPosition, rigidifierBeams, wheelNodes, wheelRow,
  wheelModifierRows, type V3, type WheelSpec,
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

function TriggerTool() {
  const [id, setId] = useState('trigger_1');
  const [type, setType] = useState<'box' | 'sphere'>('sphere');
  const [ref, setRef] = useState(''), [nx, setNx] = useState(''), [ny, setNy] = useState('');
  const [pos, setPos] = useState<V3>({ x: 0, y: 0, z: 1 });
  const [size, setSize] = useState<V3>({ x: 0.02, y: 0.05, z: 0.05 });
  const [mesh, setMesh] = useState('');
  const [action, setAction] = useState('common:toggle_headlights');
  const [action2, setAction2] = useState('');
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
    const spec = { id, idRef: ref, idX: nx, idY: ny, type, size, pos: { x: raw.x, y: raw.y, z: raw.z }, mesh: mesh || undefined, action: action || undefined, action2: action2 || undefined };
    const es = new EditSet();
    const text = t.doc.text;
    es.add(t.doc.key, insertRowsHere(text, t.part, 'triggers2', headerOf(t, 'triggers2'), [triggerRow(spec)]));
    const links = triggerLinkRows(spec);
    if (links.length) es.add(t.doc.key, insertRowsHere(text, t.part, 'triggerEventLinks2', headerOf(t, 'triggerEventLinks2'), links));
    const enable = [action, action2].filter((a) => needsActionsEnabled(a));
    if (enable.length) es.add(t.doc.key, insertRowsHere(text, t.part, 'actionsEnabled', headerOf(t, 'actionsEnabled'), enable.map((a) => fmtRow([a]))));
    if (es.apply(`Add trigger ${id}`)) {
      toast('ok', `Trigger ${id} added${enable.length ? ' (+ actionsEnabled)' : ''}`);
      setId(id.replace(/\d+$/, (m) => String(+m + 1)));
    }
  };
  return (
    <>
      <TextField label="id" value={id} onChange={setId} mono />
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
      <TextField label="mesh" value={mesh} onChange={setMesh} mono placeholder="(optional) highlight mesh" />
      <TextField label="action0" value={action} onChange={setAction} mono list={[...COMMON_ACTIONS, ...GENERIC_ACTIONS]} />
      <TextField label="action2" value={action2} onChange={setAction2} mono list={[...COMMON_ACTIONS]} placeholder="(optional)" />
      <div className="tf-actions">
        <button className="btn small" onClick={fromSel}><MousePointerClick size={12} /> From selection</button>
        <button className="btn small primary" onClick={create}>Add trigger</button>
      </div>
      <div className="tf-note">Position uses <span className="mono">baseTranslationGlobal</span> (vehicle coordinates). Box axes: X = ref→idX, Z = ref→idY, Y = Z×X; size.y is the height. Select 3 nodes in order, then “From selection”.</div>
    </>
  );
}

// ------------------------------------------------------------------------------------------

function BulbTool() {
  const [slot, setSlot] = useState('mycar_headlight_R_low_bulb');
  const [bulb, setBulb] = useState(BULB_TYPES[0].id);
  const [desc, setDesc] = useState('Right lowbeam headlight bulb');
  const [electric, setElectric] = useState('lowhighbeam');
  const [ref, setRef] = useState(''), [nx, setNx] = useState(''), [ny, setNy] = useState('');
  const [dg, setDg] = useState('');
  const [pos, setPos] = useState<V3>({ x: 0, y: -2, z: 0.6 });
  const [rot, setRot] = useState<V3>({ x: 0, y: 0, z: 180 });
  const [shadow, setShadow] = useState(true);
  const [pattern, setPattern] = useState('');
  useToolRequest('bulb', (p, n) => {
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
    }
    const c = selectionCentre();
    if (c) setPos(c);
  };
  const create = () => {
    const t = targetPart();
    if (!t) return toast('warn', 'No writable target part');
    if (ws.vehicle?.root && findSlot(slot)) return toast('warn', `Slot name "${slot}" already exists`);
    const extra: Record<string, string> = {};
    if (pattern) extra.$lightPattern = pattern;
    const row = bulbSlotRow({ slotName: slot, bulb, description: desc, electric, nodeRef: ref, nodeX: nx, nodeY: ny, deformGroup: dg, pos, rot, shadow, extra });
    const es = new EditSet();
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'slots2', headerOf(t, 'slots2'), [row]));
    if (t.part.sections.has('slots') && !t.part.sections.has('slots2')) toast('warn', 'This part uses old "slots"; the game ignores slots2 when slots exists. Convert it first.');
    if (es.apply(`Add bulb ${slot}`)) toast('ok', `Bulb slot ${slot} added`);
  };
  return (
    <>
      <TextField label="slot" value={slot} onChange={setSlot} mono />
      <label className="tf-row">
        <span className="tf-label">bulb</span>
        <select className="select small grow" value={bulb} onChange={(e) => setBulb(e.target.value)}>
          {BULB_TYPES.map((b) => <option key={b.id} value={b.id}>{b.id} — {b.use}</option>)}
        </select>
      </label>
      <TextField label="description" value={desc} onChange={setDesc} />
      <TextField label="$electric" value={electric} onChange={setElectric} mono list={['lowhighbeam', 'highbeam', 'brakelights', 'reverse', 'fog', 'signal_L', 'signal_R', 'lowbeam', 'parkingbrake']} />
      <NodeField label="$nodeRef" value={ref} onChange={setRef} />
      <NodeField label="$nodeX" value={nx} onChange={setNx} />
      <NodeField label="$nodeY" value={ny} onChange={setNy} />
      <TextField label="$deformGroup" value={dg} onChange={setDg} mono placeholder="(breaks the bulb)" />
      <VecField label="pos" value={pos} onChange={setPos} />
      <VecField label="rot" value={rot} onChange={setRot} step={5} />
      <label className="tf-row">
        <span className="tf-label">preset</span>
        <select className="select small grow" value="" onChange={(e) => {
          const p = BULB_ROT_PRESETS[+e.target.value];
          if (p) setRot(p.rot);
        }}>
          <option value="">direction preset…</option>
          {BULB_ROT_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
        </select>
      </label>
      {/headlight/i.test(bulb) && (
        <label className="tf-row"><span className="tf-label">pattern</span>
          <select className="select small grow" value={pattern} onChange={(e) => setPattern(e.target.value)}>
            <option value="">(default)</option><option value="LHD">LHD (euro)</option><option value="RHD">RHD</option><option value="US">US</option>
          </select>
        </label>
      )}
      <label className="tf-row"><span className="tf-label">shadows</span><button className={'switch' + (shadow ? ' on' : '')} onClick={() => setShadow(!shadow)} aria-label="Shadows" /></label>
      <div className="tf-actions">
        <button className="btn small" onClick={fromSel}><MousePointerClick size={12} /> From selection</button>
        <button className="btn small primary" onClick={create}>Add bulb slot</button>
      </div>
      <div className="tf-note">Position and rotation are in the vehicle (world) frame. rotZ 180 = forward, 0 = rearward; rotX 90 = down. Bulbs appear as light markers in 3D once added.</div>
    </>
  );
}

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

function WheelTool() {
  const [spec, setSpec] = useState<WheelSpec>({ name: 'FR', center: { x: -0.78, y: -1.46, z: 0.46 }, prefix: 'fw1', hubWidth: 0.14, nodeArm: '', radius: 0.36, hubRadius: 0.23, tireWidth: 0.24, numRays: 16, pressurePSI: 32, createNodes: true });
  const [mirror, setMirror] = useState(true);
  const u = (p: Partial<WheelSpec>) => setSpec({ ...spec, ...p });
  useToolRequest('wheel', (p) => {
    if (p) setSpec((s) => ({ ...s, center: p, name: p.x >= 0 ? s.name.replace(/R$/, 'L') : s.name.replace(/L$/, 'R') }));
  });
  const create = () => {
    const t = targetPart();
    if (!t) return toast('warn', 'No writable target part');
    const list: WheelSpec[] = [spec];
    if (mirror) {
      const swap: Record<string, string> = { FR: 'FL', FL: 'FR', RR: 'RL', RL: 'RR' };
      list.push({ ...spec, name: swap[spec.name] ?? spec.name + '_m', center: { ...spec.center, x: -spec.center.x }, nodeArm: spec.nodeArm ? spec.nodeArm.replace(/(l+|r+)$/, (m) => (m[0] === 'l' ? 'r' : 'l').repeat(m.length)) : '' });
    }
    const es = new EditSet();
    const text = t.doc.text;
    const dec = settings().decimals;
    const newNodes = list.flatMap((w) => wheelNodes(w)).filter((n) => !ws.vehicle?.nodeIndex.has(n.name));
    if (spec.createNodes && newNodes.length) {
      const h = headerOf(t, 'nodes');
      const r = (x: number) => Math.round(x * 10 ** dec) / 10 ** dec;
      es.add(t.doc.key, insertRowsHere(text, t.part, 'nodes', h, newNodes.map((n) => fmtRow(rowFromRecord(h, { id: n.name, posX: r(n.x), posY: r(n.y), posZ: r(n.z) }), dec))));
    }
    es.add(t.doc.key, insertRowsHere(text, t.part, 'pressureWheels', headerOf(t, 'pressureWheels'), [...wheelModifierRows(spec), ...list.map(wheelRow)]));
    if (es.apply('Add pressure wheels')) toast('ok', `Added ${list.map((w) => w.name).join(' + ')} — tune the placeholder tyre values in code`);
  };
  return (
    <>
      <TextField label="name" value={spec.name} onChange={(v) => u({ name: v })} mono list={['FR', 'FL', 'RR', 'RL']} />
      <VecField label="centre" value={spec.center} onChange={(v) => u({ center: v })} />
      <TextField label="axle prefix" value={spec.prefix} onChange={(v) => u({ prefix: v })} mono />
      <NodeField label="nodeArm" value={spec.nodeArm} onChange={(v) => u({ nodeArm: v })} />
      <div className="tf-grid">
        {([['radius', 'radius'], ['hubRadius', 'hub r'], ['tireWidth', 'tire w'], ['hubWidth', 'hub w'], ['numRays', 'rays'], ['pressurePSI', 'psi']] as const).map(([k, l]) => (
          <label key={k} className="tf-cell"><span className="faint">{l}</span><input className="input small mono" type="number" step={k === 'numRays' ? 1 : 0.005} value={spec[k]} onChange={(e) => u({ [k]: +e.target.value } as any)} onKeyDown={(e) => e.stopPropagation()} /></label>
        ))}
      </div>
      <label className="tf-row"><span className="tf-label">mirror pair</span><button className={'switch' + (mirror ? ' on' : '')} onClick={() => setMirror(!mirror)} aria-label="Mirror" /></label>
      <label className="tf-row"><span className="tf-label">axle nodes</span><button className={'switch' + (spec.createNodes ? ' on' : '')} onClick={() => u({ createNodes: !spec.createNodes })} aria-label="Create axle nodes" /><span className="faint small-text mono">{wheelNodes(spec).map((n) => n.name).join(' / ')}</span></label>
      <div className="tf-actions">
        <button className="btn small" onClick={() => { const c = selectionCentre(); if (c) u({ center: c }); else toast('info', 'Select hub nodes first'); }}><MousePointerClick size={12} /> Centre from selection</button>
        <button className="btn small primary" onClick={create}>Add wheels</button>
      </div>
      <div className="tf-note">Follows vanilla: node1 = outboard, node2 = inboard, wheelDir 1 right / −1 left, nodeS 9999. Tyre stiffness rows are placeholders — copy them from a vanilla tyre of the right size for real behaviour. The 3D view previews the tyre outline.</div>
    </>
  );
}

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
        <Section id="trigger" icon={<Zap size={14} />} title="Trigger (triggers2)"><TriggerTool /></Section>
        <Section id="bulb" icon={<Lightbulb size={14} />} title="Light bulb (slots2)"><BulbTool /></Section>
        <Section id="occupant" icon={<Armchair size={14} />} title="Occupant seat (0.40)"><OccupantTool /></Section>
        <Section id="wheel" icon={<CircleDot size={14} />} title="Pressure wheels"><WheelTool /></Section>
        <Section id="rail" icon={<Route size={14} />} title="Rails & slidenodes"><RailTool /></Section>
        <Section id="subdivide" icon={<Box size={14} />} title="Subdivide between nodes"><NodeTool /></Section>
      </div>
    </div>
  );
}

export { useUi };
