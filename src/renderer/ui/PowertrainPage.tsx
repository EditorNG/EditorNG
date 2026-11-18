/**
 * Powertrain panel (in place of the 3D view, next to the code): the engine's torque and power as
 * the game computes them (torque table, intake / exhaust / multiplier tables, turbo, supercharger,
 * nitrous, friction), every value of the engine and its forced induction with the parts that set
 * or modify it, the gearbox and the final drive. Edits go into the JBeam where the value is
 * written and the code editor shows the line; tuning variables go into the configuration.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Minus, Lock, ChevronRight, Copy } from 'lucide-react';
import { useWs, ws } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { revealRange } from '../editor/CodeEditor';
import * as ops from '../project/ops';
import {
  readPowertrain, peak, baseFor, kW, PS, HP, roadSpeed, engineLayers, ptData, curvesOf, withLayerEdit, layerValue, solveLayerScale, createCurve,
  type PtGearbox, type PtFinalDrive, type PtCell, type PtProp, type PtSection, type PtLayer, type PtData, type LayerEdit, type EngineCurves, type PtEngine, type PtLut,
} from '@core/analysis/powertrain';
import { resolveTree, buildVehicle } from '@core/jbeam/assemble';
import { parseConfig } from '@core/jbeam/config';
import type { Vehicle } from '@core/jbeam/types';
import type { AArr } from '@core/sjson';
import { configName, copyPartForConfig, cannotCopyFor, readInfo, writeInfo } from '../project/configEdits';
import { openMenu } from './Menu';
import { toast } from '../state/toast';

type Unit = 'kW' | 'PS' | 'hp';
const power = (u: Unit, tq: number, rpm: number) => (u === 'kW' ? kW(tq, rpm) : u === 'PS' ? PS(kW(tq, rpm)) : HP(kW(tq, rpm)));
/** a number with `d` decimals; tiny coefficients (5e-7) keep 3 significant digits */
const fmt = (x: number, d: number) => {
  if (!Number.isFinite(x)) return '—';
  if (x !== 0 && Math.abs(x) < 0.5 * 10 ** -d) return String(+x.toPrecision(3));
  return String(+x.toFixed(d));
};
const loadUnit = (): Unit => {
  try {
    const u = localStorage.getItem('pt.unit');
    return u === 'PS' || u === 'hp' ? u : 'kW';
  } catch {
    return 'kW';
  }
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** shows where a value lives in the code (without taking the focus) */
function reveal(file: string | undefined, node: { s: number; e: number } | null | undefined) {
  if (file && node) revealRange(file, node.s, node.e, false);
  else if (file) {
    const d = ws.doc(file);
    if (d) openTab(d.key);
  }
}

const writable = (file?: string) => !!file && !!ws.doc(file)?.writable;

/** the pixel width of an element (charts draw at their real size: round points, crisp text) */
function useWidth(ref: React.RefObject<Element | null>, fallback: number): number {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, Math.round(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

// ---------------------------------------------------------------------------------------------
// configurations
// ---------------------------------------------------------------------------------------------

/** One configuration of the vehicle: the parts it installs and its engine data. */
interface PtConfig {
  key: string;
  name: string;
  active: boolean;
  parts: Set<string>;
  data: PtData | null;
  curves: EngineCurves | null;
}

/** Every .pc of the vehicle, assembled (sections only: a few ms each). The open one as shown. */
function assembleConfigs(engine: string): PtConfig[] {
  const st = useWs.getState();
  const active = st.activeConfig.toLowerCase();
  const out: PtConfig[] = [];
  const add = (key: string, name: string, isActive: boolean, veh: Vehicle | null) => {
    const data = veh ? ptData(veh, engine) : null;
    out.push({ key, name, active: isActive, parts: new Set(veh?.parts.map((p) => p.def.name) ?? []), data, curves: curvesOf(data) });
  };
  for (const d of st.configs) {
    const isActive = d.key.toLowerCase() === active;
    let veh: Vehicle | null = null;
    if (isActive) veh = ws.vehicle;
    else if (ws.lib) {
      try {
        const cfg = parseConfig(d.text);
        const res = resolveTree(ws.lib, cfg);
        if (res.root) veh = buildVehicle(res.parts, cfg, res.issues, { dictsOnly: true });
      } catch {
        veh = null;
      }
    }
    add(d.key, configName(d.key), isActive, veh);
  }
  if (!out.some((c) => c.active) && ws.vehicle) add('', '(current parts)', true, ws.vehicle);
  return out;
}

/** configurations that install a part */
const UsersCtx = createContext<(part: string) => PtConfig[]>(() => []);

/** A change being previewed (a drag, a scale): every curve shows it before it is written. */
interface Preview {
  layer: PtLayer;
  edit: LayerEdit;
}

/** curves of a configuration with the preview applied (only where it has the same layer) */
function previewCurves(c: PtConfig, p: Preview | null, original: unknown): EngineCurves | null {
  // only where the configuration installs that part (a copy has the same values as its original)
  if (!p || !c.data || !c.parts.has(p.layer.part)) return c.curves;
  const d = withLayerEdit(c.data, p.layer, p.edit, original);
  return d === c.data ? c.curves : curvesOf(d);
}

/** shared parts the user chose to edit for every configuration that uses them (this session) */
const editAll = new Set<string>();

// ---------------------------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------------------------

export default function PowertrainPanel() {
  const v = useWs((x) => x.vehicle);
  const cfgDocs = useWs((x) => x.configs);
  const activeKey = useWs((x) => x.activeConfig);
  const pt = useMemo(() => (v ? readPowertrain(v) : null), [v]);
  const [unit, setUnitState] = useState<Unit>(loadUnit);
  const [engineIdx, setEngineIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const setUnit = (u: Unit) => {
    setUnitState(u);
    try {
      localStorage.setItem('pt.unit', u);
    } catch {
      /* per-viewer convenience */
    }
  };
  const e = pt?.engines[Math.min(engineIdx, (pt?.engines.length ?? 1) - 1)] ?? null;
  const layers = useMemo(() => (e ? engineLayers(e) : []), [e]);
  const configs = useMemo(() => (e ? assembleConfigs(e.name) : []), [v, cfgDocs, activeKey, e]);
  const active = configs.find((c) => c.active) ?? null;
  const users = useMemo(() => (part: string) => configs.filter((c) => c.parts.has(part)), [configs]);
  const original = preview && active?.data ? layerValue(active.data, preview.layer) : undefined;
  const curves = active ? previewCurves(active, preview, original) : null;
  const maxRpm = curves?.maxRPM ?? 7000;
  const final = pt?.finalDrives.length ? Math.max(...pt.finalDrives.map((f) => f.ratio.value)) : 1;
  const [pT, pTr] = curves ? peak(curves.final) : [0, 0];
  const [pP, pPr] = curves ? peak(curves.final, (t, r) => power(unit, t, r)) : [0, 0];
  const selLayer = layers.find((l) => l.id === selected) ?? null;
  return (
    <UsersCtx.Provider value={users}>
      <div className="ptp">
        <div className="ptp-bar">
          <span className="panel-title">Powertrain</span>
          {active && <span className="ptp-cfgname mono" data-tip="The configuration shown (pick another in Configurations)">{active.name}</span>}
          {pt && pt.engines.length > 1 && (
            <div className="segmented small">
              {pt.engines.map((x, i) => <button key={x.name} className={'seg' + (x === e ? ' active' : '')} style={{ textTransform: 'none' }} onClick={() => setEngineIdx(i)}>{x.name}</button>)}
            </div>
          )}
          {curves && (
            <div className="ptp-peaks">
              <span><b>{fmt(pT, 0)}</b> Nm <i>{fmt(pTr, 0)} rpm</i></span>
              <span><b>{fmt(pP, 0)}</b> {unit} <i>{fmt(pPr, 0)} rpm</i></span>
            </div>
          )}
          <div className="grow" />
          <div className="segmented small">
            {(['kW', 'PS', 'hp'] as const).map((u) => <button key={u} className={'seg' + (unit === u ? ' active' : '')} style={{ textTransform: 'none' }} onClick={() => setUnit(u)}>{u}</button>)}
          </div>
          <button className="icon-btn" data-tip="Back to the 3D view" onClick={() => useUi.setState({ page: 'workbench' })} aria-label="Close"><X size={15} /></button>
        </div>
        <div className="ptp-body">
          {!v && <div className="empty-hint">No vehicle open</div>}
          {pt && !pt.engines.length && !pt.gearboxes.length && <div className="empty-hint">No engine or gearbox in the installed parts</div>}
          {e && active?.data && curves && (
            <EngineChart e={e} layers={layers} configs={configs} curves={curves} preview={preview} setPreview={setPreview} focus={preview?.layer ?? selLayer} original={original} unit={unit} />
          )}
          {e && active?.data && layers.length > 0 && (
            <LayersBox layers={layers} active={active} selected={selLayer} setSelected={(id) => { setSelected(id); setPreview(null); }} setPreview={setPreview} unit={unit} rpmMax={maxRpm} />
          )}
          {configs.length > 1 && <ConfigsBox configs={configs} preview={preview} original={original} unit={unit} />}
          <div className="ptp-grid">
            {e && <SectionBox title="Engine" sub={e.name} sec={e.section} primary={ENGINE_KEYS} />}
            {e?.turbo && <SectionBox title="Turbocharger" sub={e.turbo.name} sec={e.turbo} primary={TURBO_KEYS} />}
            {e?.supercharger && <SectionBox title="Supercharger" sub={e.supercharger.name} sec={e.supercharger} primary={SC_KEYS} />}
            {e?.nitrous && <SectionBox title="Nitrous" sub={e.nitrous.name} sec={e.nitrous} primary={N2O_KEYS} />}
            {pt?.gearboxes.map((g) => <GearboxBox key={g.name + g.part} g={g} drives={pt.finalDrives} final={final} maxRpm={maxRpm} radius={pt.wheelRadius} />)}
          </div>
        </div>
      </div>
    </UsersCtx.Provider>
  );
}

const ENGINE_KEYS = ['idleRPM', 'maxRPM', 'revLimiterRPM', 'hasRevLimiter', 'revLimiterType', 'revLimiterRPMDrop', 'revLimiterCutTime', 'maxPhysicalRPM', 'redlineTorqueDropOffRange', 'inertia', 'friction', 'dynamicFriction', 'engineBrakeTorque', 'maxTorqueRating', 'maxOverTorqueDamage'];
const TURBO_KEYS = ['wastegateStart', 'wastegateLimit', 'maxExhaustPower', 'backPressureCoef', 'frictionCoef', 'inertia', 'pressureRatePSI', 'turboSizeCoef'];
const SC_KEYS = ['type', 'gearRatio', 'pressurePSIPer1kRPM', 'crankLossPer1kRPM', 'clutchEngageRPM', 'clutchDisengageRPM', 'maxRPM', 'twistedLobes', 'lobes', 'pressureRatePSI'];
const N2O_KEYS = ['addedPower', 'cutInRPM', 'cutInRange', 'minimumGear'];

// ---------------------------------------------------------------------------------------------
// fields
// ---------------------------------------------------------------------------------------------

/** A number written in the file (literal), a tuning variable, or an expression (locked). */
function CellField({ c, label, decimals = 3, width = 76, onCommit, readOnly = false }: { c: PtCell; label: string; decimals?: number; width?: number; onCommit?: (n: number) => void; readOnly?: boolean }) {
  const [txt, setTxt] = useState(fmt(c.value, decimals));
  useEffect(() => setTxt(fmt(c.value, decimals)), [c.value]);
  const varDef = c.varName ? ws.vehicle?.variables.find((x) => x.name === c.varName) : undefined;
  const editable = !readOnly && (!!onCommit || (c.node ? writable(c.file) : !!varDef));
  if (!editable) {
    const why = readOnly ? 'Pick who the change is for first (above)' : c.expr ? `Expression ${c.expr}: edit it in the code` : c.varName ? `${c.varName}: not a tuning variable of this configuration` : 'Game file (read-only)';
    return <span className="ptp-locked mono" data-tip={why} style={{ width }} onClick={() => reveal(c.file, c.node)}><Lock size={10} />{fmt(c.value, decimals)}</span>;
  }
  const commit = () => {
    const n = Number(txt);
    if (!Number.isFinite(n) || n === c.value) return setTxt(fmt(c.value, decimals));
    if (onCommit) return onCommit(n);
    if (c.node) {
      ops.setNumbers([{ file: c.file!, node: c.node, value: n, decimals }], label);
      reveal(c.file, c.node);
    } else if (varDef) ws.setVar(varDef.name, Math.min(varDef.max, Math.max(varDef.min, n)));
  };
  return (
    <span className={'ptp-field' + (varDef ? ' var' : '')} data-tip={varDef ? `${varDef.name} (tuning variable, ${fmt(varDef.min, 3)} – ${fmt(varDef.max, 3)}): the configuration's value` : undefined}>
      {varDef && <span className="ptp-var">$</span>}
      <input className="input small mono" style={{ width }} value={txt} onChange={(ev) => setTxt(ev.target.value)} onFocus={() => reveal(c.file, c.node ?? varDef?.row ?? null)} onBlur={commit}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
          if (ev.key === 'Escape') {
            setTxt(fmt(c.value, decimals));
            (ev.target as HTMLInputElement).blur();
          }
        }} />
    </span>
  );
}

const OP_LABEL: Record<string, string> = { '+': '+', '*': '×', '<': 'max', '>': 'min' };

/** A key of a section: its value as the game gets it, and the parts that set or modify it. */
/** a part's name, and how many configurations use it */
function SrcButton({ part, file, node }: { part?: string; file?: string; node?: { s: number; e: number } | null }) {
  const usersOf = useContext(UsersCtx);
  const u = part ? usersOf(part) : [];
  return (
    <button className="ptp-src" onClick={() => reveal(file, node)} data-tip={part ? `${part} · ${file}${u.length ? `\nUsed by ${u.map((c) => c.name).join(', ')}` : ''}` : undefined}>
      {part}{u.length > 1 && <i className="ptp-n">{u.length}</i>}
    </button>
  );
}

function PropRow({ p, decimals = 3, readOnly = false }: { p: PtProp; decimals?: number; readOnly?: boolean }) {
  const base = p.sources[0];
  const mods = p.sources.slice(1);
  const num = typeof p.value === 'number';
  let main: React.ReactNode;
  if (!num || !base) {
    main = <span className="ptp-text mono" onClick={() => reveal(base?.file, base?.cell.node)}>{p.value === undefined ? '—' : String(p.value)}</span>;
  } else if (!mods.length) {
    main = <CellField c={base.cell} label={p.key} decimals={decimals} readOnly={readOnly} />;
  } else {
    // the result of the chain: editing it writes the base value that gives it
    const eff: PtCell = { value: p.value as number, node: null };
    const canInvert = (base.cell.node && writable(base.file)) || !!base.cell.varName;
    main = (
      <CellField c={eff} label={p.key} decimals={decimals} readOnly={readOnly} onCommit={canInvert ? (n) => {
        const b = baseFor(p, n);
        if (b === null) return toast('warn', `${p.key}: a cap or floor in the chain; edit the parts' values below`);
        if (base.cell.node) {
          ops.setNumbers([{ file: base.file, node: base.cell.node, value: b, decimals }], p.key);
          reveal(base.file, base.cell.node);
        } else if (base.cell.varName) ws.setVar(base.cell.varName, b);
      } : undefined} />
    );
  }
  return (
    <>
      <div className="ptp-prop">
        <span className="ptp-key mono" data-tip={p.key}>{p.key}</span>
        {main}
        <SrcButton part={base?.part} file={base?.file} node={base?.cell.node} />
      </div>
      {mods.map((m, i) => (
        <div key={i} className="ptp-prop mod">
          <span className="ptp-key mono">{OP_LABEL[m.op]}</span>
          <CellField c={m.cell} label={p.key} decimals={decimals} readOnly={readOnly} />
          <SrcButton part={m.part} file={m.file} node={m.cell.node} />
        </div>
      ))}
    </>
  );
}

function SectionBox({ title, sub, sec, primary, children }: { title: string; sub?: string; sec: PtSection; primary: string[]; children?: React.ReactNode }) {
  const [more, setMore] = useState(false);
  const first = primary.map((k) => sec.props.find((p) => p.key === k)).filter((p): p is PtProp => !!p);
  const rest = sec.props.filter((p) => !primary.includes(p.key)).sort((a, b) => a.key.localeCompare(b.key));
  return (
    <section className="ptp-box">
      <header><span className="panel-title">{title}</span>{sub && <span className="faint mono small-text">{sub}</span>}</header>
      {children}
      <div className="ptp-props">
        {first.map((p) => <PropRow key={p.key} p={p} />)}
        {rest.length > 0 && (
          <button className="ptp-more" onClick={() => setMore(!more)}>
            <ChevronRight size={12} style={{ transform: more ? 'rotate(90deg)' : undefined }} /> {rest.length} more
          </button>
        )}
        {more && rest.map((p) => <PropRow key={p.key} p={p} />)}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// chart
// ---------------------------------------------------------------------------------------------

interface Series {
  key: string;
  label: string;
  cls: string;
  values: Float64Array | Array<[number, number]> | null;
  axis: 'l' | 'r';
  unit?: string;
}

/** Editable points of a table: x / y columns of its rows. */
interface EditSpec {
  lut: PtLut;
  xCol: number;
  yCol: number;
  axis: 'l' | 'r';
  label: string;
  xDec: number;
  yDec: number;
  /** draw straight lines through the points (tables the game reads point to point) */
  line?: boolean;
  /** shown but not editable */
  locked?: boolean;
}

type Drag = { i: number; x: number; y: number } | null;

const CH = 280, ML = 46, MR = 50, MT = 10, MB = 24;

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo || 1;
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) out.push(+x.toFixed(6));
  return out;
}

function range(series: Series[], axis: 'l' | 'r', extra: number[]): [number, number] {
  let lo = 0, hi = -Infinity;
  for (const s of series) {
    if (s.axis !== axis || !s.values) continue;
    if (s.values instanceof Float64Array) {
      for (let i = 0; i < s.values.length; i += 5) if (!Number.isNaN(s.values[i])) {
        lo = Math.min(lo, s.values[i]);
        hi = Math.max(hi, s.values[i]);
      }
    } else for (const [, y] of s.values) {
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  for (const y of extra) {
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  if (hi === -Infinity) hi = 1;
  const pad = (hi - lo) * 0.1 || 1;
  return [lo < 0 ? lo - pad : 0, hi + pad];
}

function Chart({ height = CH, xMax, xUnit, lUnit, rUnit, series, edit, markers, onDragChange, ghosts, dragNote, pointNote }: {
  height?: number; xMax: number; xUnit: string; lUnit: string; rUnit?: string;
  series: (drag: Drag) => Series[];
  edit?: EditSpec | null;
  markers?: Array<{ x: number; label: string; cls: string }>;
  onDragChange?: (d: Drag) => void;
  /** other configurations' torque, drawn faintly with their names */
  ghosts?: Array<{ label: string; values: Float64Array | null }>;
  /** what a drag changes (shown next to the point while dragging) */
  dragNote?: string;
  /** tooltip of the points */
  pointNote?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const W = useWidth(svg, 720);
  const H = height;
  const [drag, setDragState] = useState<Drag>(null);
  const [hover, setHover] = useState<number | null>(null);
  const setDrag = (d: Drag) => {
    setDragState(d);
    onDragChange?.(d);
  };
  const own = series(drag);
  const ghostSeries: Series[] = (ghosts ?? []).map((g, i) => ({ key: 'ghost' + i, label: g.label, cls: 'ghost', values: g.values, axis: 'l' }));
  // ghosts count for the scale, not for the readout
  const list = [...ghostSeries, ...own];
  const pts = edit ? edit.lut.rows.map((r, i) => {
    const x = r.cells[edit.xCol], y = r.cells[edit.yCol];
    return drag && drag.i === i ? { x: drag.x, y: drag.y, cx: x, cy: y, row: r.row } : { x: x?.value ?? NaN, y: y?.value ?? NaN, cx: x, cy: y, row: r.row };
  }) : [];
  const editY = pts.map((p) => p.y).filter(Number.isFinite);
  // the scale holds still while a point is dragged (else it runs away with the mouse)
  const frozen = useRef<{ l: [number, number]; r: [number, number] } | null>(null);
  const clipId = useMemo(() => 'ptpclip' + Math.random().toString(36).slice(2), []);
  const live = { l: range(list, 'l', edit?.axis === 'l' ? editY : []), r: range(list, 'r', edit?.axis === 'r' ? editY : []) };
  const [lLo, lHi] = drag && frozen.current ? frozen.current.l : live.l;
  const [rLo, rHi] = drag && frozen.current ? frozen.current.r : live.r;
  const X = (x: number) => ML + (x / xMax) * (W - ML - MR);
  const Yl = (y: number) => H - MB - ((y - lLo) / (lHi - lLo)) * (H - MT - MB);
  const Yr = (y: number) => H - MB - ((y - rLo) / (rHi - rLo)) * (H - MT - MB);
  const Y = (axis: 'l' | 'r') => (axis === 'l' ? Yl : Yr);
  const toData = (ev: { clientX: number; clientY: number }, axis: 'l' | 'r') => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((ev.clientX - r.left) / r.width) * W, sy = ((ev.clientY - r.top) / r.height) * H;
    const [lo, hi] = axis === 'l' ? [lLo, lHi] : [rLo, rHi];
    return { x: ((sx - ML) / (W - ML - MR)) * xMax, y: lo + ((H - MB - sy) / (H - MT - MB)) * (hi - lo) };
  };
  const path = (s: Series) => {
    if (!s.values) return '';
    const y = Y(s.axis);
    const out: string[] = [];
    if (s.values instanceof Float64Array) {
      const step = Math.max(1, Math.floor(xMax / (W - ML - MR) / 1.5));
      let pen = false;
      for (let i = 0; i < s.values.length && i <= xMax; i += step) {
        const v = s.values[i];
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        out.push(`${pen ? 'L' : 'M'}${X(i).toFixed(1)},${y(v).toFixed(1)}`);
        pen = true;
      }
    } else s.values.forEach(([a, b], i) => out.push(`${i ? 'L' : 'M'}${X(a).toFixed(1)},${y(b).toFixed(1)}`));
    return out.join('');
  };
  const canEdit = !!edit && !edit.locked && writable(edit.lut.file);
  const commit = (d: NonNullable<Drag>) => {
    if (!edit) return;
    const p = pts[d.i];
    const edits: Array<{ file: string; node: any; value: number; decimals: number }> = [];
    const xr = Math.round(d.x * 10 ** edit.xDec) / 10 ** edit.xDec, yr = Math.round(d.y * 10 ** edit.yDec) / 10 ** edit.yDec;
    if (p.cx?.node && xr !== p.cx.value) edits.push({ file: edit.lut.file, node: p.cx.node, value: xr, decimals: edit.xDec });
    if (p.cy?.node && yr !== p.cy.value) edits.push({ file: edit.lut.file, node: p.cy.node, value: yr, decimals: edit.yDec });
    if (edits.length) ops.setNumbers(edits, edit.label);
  };
  // the value under the mouse (x readout)
  // the value under the mouse (x readout), most important first
  const hoverVals = hover !== null ? own.filter((s) => s.values instanceof Float64Array).map((s) => ({ s, v: (s.values as Float64Array)[Math.round(hover)] })).reverse() : [];
  return (
    <svg ref={svg} className="ptp-chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }}
      onPointerMove={(ev) => {
        const d = toData(ev, 'l');
        setHover(d.x >= 0 && d.x <= xMax ? d.x : null);
      }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={(ev) => {
        if (!edit || !canEdit) return;
        const d = toData(ev, edit.axis);
        if (d.x < 0 || d.x > xMax) return;
        let after = -1;
        pts.forEach((p, i) => p.x < d.x && (after = i));
        const row = after >= 0 ? pts[after].row : edit.lut.header ? (edit.lut.arr.items[0] as AArr) : null;
        if (!row) return;
        // the other columns copy the nearest row
        const near = pts[Math.max(0, after)]?.row ?? pts[0]?.row;
        const cells = (near?.items ?? []).map((n) => (n.k === 'num' ? n.v : 0));
        cells[edit.xCol] = Math.round(d.x * 10 ** edit.xDec) / 10 ** edit.xDec;
        cells[edit.yCol] = Math.round(d.y * 10 ** edit.yDec) / 10 ** edit.yDec;
        ops.insertTableRowAfter(edit.lut.file, row, cells, `Add point to ${edit.lut.key}`);
      }}>
      {niceTicks(0, xMax, 8).filter((x) => X(x) < W - MR - 24).map((x) => <g key={'x' + x} className="ptp-grid"><line x1={X(x)} x2={X(x)} y1={MT} y2={H - MB} /><text x={X(x)} y={H - MB + 15} textAnchor="middle">{x >= 1000 ? `${x / 1000}k` : x}</text></g>)}
      {niceTicks(lLo, lHi, 5).map((t) => <g key={'l' + t} className="ptp-grid"><line x1={ML} x2={W - MR} y1={Yl(t)} y2={Yl(t)} className={t === 0 ? 'zero' : undefined} /><text x={ML - 6} y={Yl(t) + 4} textAnchor="end">{t}</text></g>)}
      {rUnit && niceTicks(rLo, rHi, 5).map((t) => <text key={'r' + t} className="ptp-axis r" x={W - MR + 6} y={Yr(t) + 4}>{t}</text>)}
      <text className="ptp-axis" x={ML - 6} y={MT + 2} textAnchor="end" dominantBaseline="hanging">{lUnit}</text>
      {rUnit && <text className="ptp-axis r" x={W - MR + 6} y={MT + 2} dominantBaseline="hanging">{rUnit}</text>}
      <text className="ptp-axis" x={W - MR} y={H - 4} textAnchor="end">{xUnit}</text>
      {markers?.filter((m) => Number.isFinite(m.x) && m.x <= xMax).map((m, i) => (
        <g key={m.label} className={'ptp-marker ' + m.cls}>
          <line x1={X(m.x)} x2={X(m.x)} y1={MT} y2={H - MB} />
          <text x={X(m.x) - 4} y={MT + 10 + i * 12} textAnchor="end">{m.label}</text>
        </g>
      ))}
      <clipPath id={clipId}><rect x={ML} y={MT} width={W - ML - MR} height={H - MT - MB} /></clipPath>
      <g clipPath={`url(#${clipId})`}>{list.map((s) => <path key={s.key} className={'ptp-line ' + s.cls} d={path(s)} />)}</g>
      {(() => {
        // names at the end of the lines, pushed apart so they don't overlap
        const labels = ghostSeries.flatMap((g) => {
          const v = g.values as Float64Array | null;
          if (!v) return [];
          let k = Math.min(v.length - 1, Math.floor(xMax));
          while (k > 0 && Number.isNaN(v[k])) k--;
          return k > 0 ? [{ key: g.key, label: g.label, x: X(k) + 4, y: Y('l')(v[k]) + 3 }] : [];
        }).sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 11) labels[i].y = labels[i - 1].y + 11;
        return labels.map((l) => <text key={l.key + 't'} className="ptp-ghost-label" x={l.x} y={l.y}>{l.label}</text>);
      })()}
      {edit?.line && <path className="ptp-line mod" d={pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(edit.axis)(p.y).toFixed(1)}`).join('')} />}
      {hover !== null && !drag && (
        <g className="ptp-hover">
          <line x1={X(hover)} x2={X(hover)} y1={MT} y2={H - MB} />
          {hoverVals.map(({ s, v }) => Number.isFinite(v) && <circle key={s.key} className={s.cls} cx={X(hover)} cy={Y(s.axis)(v)} r={3} />)}
          <text x={X(hover) + (X(hover) > W - 180 ? -8 : 8)} y={MT + 12} textAnchor={X(hover) > W - 180 ? 'end' : 'start'}>
            {[`${fmt(hover, 0)} ${xUnit}`, ...hoverVals.filter(({ v }) => Number.isFinite(v)).map(({ s, v }) => [s.label, fmt(v, Math.abs(v) < 10 ? 2 : 0), s.unit].filter(Boolean).join(' '))].join('  ·  ')}
          </text>
        </g>
      )}
      {edit && pts.map((p, i) => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        const locked = !canEdit || (!p.cx?.node && !p.cy?.node);
        return (
          <circle key={i} className={'ptp-pt' + (locked ? ' locked' : '') + (drag?.i === i ? ' active' : '')} cx={X(p.x)} cy={Y(edit.axis)(p.y)} r={5}
            onPointerDown={(ev) => {
              if (ev.button !== 0) return;
              ev.stopPropagation();
              reveal(edit.lut.file, p.row);
              if (locked) return;
              try {
                (ev.target as Element).setPointerCapture(ev.pointerId);
              } catch {
                /* capture is a nicety */
              }
              frozen.current = { l: [lLo, lHi], r: [rLo, rHi] };
              setDrag({ i, x: p.x, y: p.y });
            }}
            onPointerMove={(ev) => {
              if (!drag || drag.i !== i) return;
              const d = toData(ev, edit.axis);
              const lo = i > 0 ? pts[i - 1].x + 1 : 0;
              const hi = i + 1 < pts.length ? pts[i + 1].x - 1 : xMax * 1.5;
              const x = p.cx?.node && !ev.shiftKey ? Math.min(hi, Math.max(lo, d.x)) : p.cx?.value ?? p.x;
              const y = p.cy?.node && !ev.ctrlKey ? d.y : p.cy?.value ?? p.y;
              setDrag({ i, x, y });
            }}
            onPointerUp={() => {
              if (drag && drag.i === i) commit(drag);
              setDrag(null);
            }}
            onContextMenu={(ev) => {
              ev.preventDefault();
              openMenu(ev.clientX, ev.clientY, [
                { label: `${fmt(p.x, edit.xDec)} · ${fmt(p.y, edit.yDec)}`, disabled: edit.lut.key },
                { label: 'Delete point', disabled: locked ? 'Read-only' : pts.length > 2 ? false : 'A curve needs two points', run: () => ops.deleteTableRow(edit.lut.file, p.row, `Delete point of ${edit.lut.key}`) },
                { label: 'Show in code', run: () => revealRange(edit.lut.file, p.row.s, p.row.e, true) },
              ]);
            }}>
            <title>{`${fmt(p.x, edit.xDec)} · ${fmt(p.y, edit.yDec)}${pointNote ? `\n${pointNote}` : ''}${locked ? '' : '\nDrag (Shift: vertical only, Ctrl: horizontal only) · double-click the chart to add · right-click to delete'}`}</title>
          </circle>
        );
      })}
      {drag && edit && (() => {
        const left = X(drag.x) > W - 260;
        const x = X(drag.x) + (left ? -10 : 10), y = Y(edit.axis)(drag.y);
        return (
          <g className="ptp-drag-tip">
            <text className="ptp-drag" x={x} y={y - 22} textAnchor={left ? 'end' : 'start'}>{`${fmt(drag.x, edit.xDec)} · ${fmt(drag.y, edit.yDec)}`}</text>
            {dragNote && <text className="ptp-drag note" x={x} y={y - 8} textAnchor={left ? 'end' : 'start'}>{dragNote}</text>}
          </g>
        );
      })()}
    </svg>
  );
}

function Legend({ items, hidden, toggle }: { items: Array<{ key: string; label: string; cls: string }>; hidden: Set<string>; toggle: (k: string) => void }) {
  return (
    <div className="ptp-legend">
      {items.map((it) => (
        <button key={it.key} className={'ptp-leg' + (hidden.has(it.key) ? ' off' : '')} onClick={() => toggle(it.key)}>
          <i className={it.cls} />{it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------------------------

/**
 * Torque and power of the configuration, as the game computes them. The points are the base
 * torque table of the engine part (what dragging them changes, for every configuration with that
 * engine); the other configurations of the layer in focus are drawn faintly and follow a preview.
 */
function EngineChart({ e, layers, configs, curves, preview, setPreview, focus, original, unit }: {
  e: PtEngine; layers: PtLayer[]; configs: PtConfig[]; curves: EngineCurves; preview: Preview | null; setPreview: (p: Preview | null) => void;
  focus: PtLayer | null; original: unknown; unit: Unit;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  });
  const usersOf = useContext(UsersCtx);
  const torque = layers.find((l) => l.id === 'torque')!;
  const tUsers = usersOf(torque.part);
  const tOthers = tUsers.filter((c) => !c.active);
  const data = e.section.data;
  const boosted = !!(curves.boostCoef || curves.nitrous);
  const xMax = Math.ceil((Math.max(curves.maxRPM, Number(data.maxRPM) || 0) * 1.04) / 500) * 500;
  // the other configurations that have the layer in focus, with the change previewed
  const ghosts = focus && !hidden.has('others')
    ? configs.filter((c) => !c.active && c.parts.has(focus.part)).map((c) => ({ label: c.name, values: previewCurves(c, preview && preview.layer === focus ? preview : null, original)?.final ?? null }))
    : [];
  const items = [
    { key: 'final', label: 'Torque', cls: 'tq' },
    { key: 'power', label: `Power (${unit})`, cls: 'pw' },
    ...(boosted ? [{ key: 'na', label: 'Without boost', cls: 'na' }] : []),
    { key: 'table', label: 'Base table', cls: 'tbl' },
    ...(focus && configs.some((c) => !c.active && c.parts.has(focus.part)) ? [{ key: 'others', label: `Other configs (${focus.label})`, cls: 'ghost' }] : []),
  ];
  const powerOf = (c: Float64Array) => {
    const out = new Float64Array(c.length);
    for (let k = 0; k < c.length; k++) out[k] = Number.isNaN(c[k]) ? NaN : power(unit, c[k], k);
    return out;
  };
  const effective = (k: string) => {
    const p = e.section.props.find((x) => x.key === k);
    return typeof p?.value === 'number' ? p.value : NaN;
  };
  const users = tUsers.map((c) => c.name).join(', ');
  return (
    <section className="ptp-box wide">
      <header>
        <span className="panel-title">Torque &amp; power</span>
        <div className="grow" />
        <Legend items={items} hidden={hidden} toggle={toggle} />
      </header>
      <Chart xMax={xMax} xUnit="rpm" lUnit="Nm" rUnit={unit}
        markers={[
          { x: effective('idleRPM'), label: 'idle', cls: 'idle' },
          { x: effective('maxRPM'), label: 'max', cls: 'max' },
          ...(data.hasRevLimiter === false ? [] : [{ x: effective('revLimiterRPM'), label: 'limiter', cls: 'lim' }]),
        ]}
        edit={{ lut: torque.lut!, xCol: 0, yCol: 1, axis: 'l', label: 'Edit base torque table', xDec: 0, yDec: 1 }}
        pointNote={`Base torque table of ${torque.part}: the engine without intake, exhaust, multiplier, boost or friction.\nUsed by ${plural(tUsers.length, 'configuration')}: ${users}`}
        dragNote={`Base torque table · ${torque.part}${tOthers.length ? ` · also changes ${plural(tOthers.length, 'other configuration')}` : ''}`}
        onDragChange={(d) => setPreview(d ? { layer: torque, edit: { kind: 'point', ...d } } : null)}
        ghosts={ghosts}
        series={() => [
          { key: 'table', label: 'base', unit: 'Nm', cls: 'tbl', values: hidden.has('table') ? null : curves.table, axis: 'l' as const },
          { key: 'na', label: 'no boost', unit: 'Nm', cls: 'na', values: boosted && !hidden.has('na') ? curves.na : null, axis: 'l' as const },
          { key: 'power', label: '', unit, cls: 'pw', values: hidden.has('power') ? null : powerOf(curves.final), axis: 'r' as const },
          { key: 'final', label: '', unit: 'Nm', cls: 'tq', values: hidden.has('final') ? null : curves.final, axis: 'l' as const },
        ]} />
    </section>
  );
}

const yDecOf = (l: PtLayer) => (l.unit === 'Nm' ? 1 : l.unit === 'psi' ? 2 : 3);

/** The layers of the configuration's torque: each is written in one part, used by some configurations. */
function LayersBox({ layers, active, selected, setSelected, setPreview, unit, rpmMax }: {
  layers: PtLayer[]; active: PtConfig; selected: PtLayer | null; setSelected: (id: string | null) => void; setPreview: (p: Preview | null) => void; unit: Unit; rpmMax: number;
}) {
  const usersOf = useContext(UsersCtx);
  return (
    <section className="ptp-box wide">
      <header><span className="panel-title">Layers</span><span className="faint small-text">pick one to edit it</span></header>
      <div className="ptp-layers">
        {layers.map((l) => {
          const u = usersOf(l.part);
          const on = selected?.id === l.id;
          return (
            <button key={l.id} className={'ptp-layer' + (on ? ' active' : '')} onClick={() => setSelected(on ? null : l.id)}>
              <span className="ptp-layer-name">{l.label}</span>
              <span className="mono faint ellipsis" data-tip={l.file}>{l.part}</span>
              {!writable(l.file) && <span className="faint" data-tip="Game file"><Lock size={10} /></span>}
              <span className={'ptp-reach' + (u.length > 1 ? ' shared' : '')} data-tip={`Used by ${u.map((c) => c.name).join(', ') || 'no saved configuration'}`}>{u.length}</span>
            </button>
          );
        })}
      </div>
      {selected && <LayerEditor key={selected.id + '|' + selected.part} layer={selected} active={active} setPreview={setPreview} unit={unit} rpmMax={rpmMax} />}
    </section>
  );
}

/** Scales a layer: every literal value of its table (or its one value) times f. */
function applyScale(layer: PtLayer, f: number): boolean {
  if (layer.lut) {
    const dec = yDecOf(layer);
    const cells = layer.lut.rows.map((r) => r.cells[layer.yCol]).filter((c): c is PtCell => !!c);
    const edits = cells.filter((c) => c.node).map((c) => ({ file: layer.file, node: c.node!, value: Math.round(c.value * f * 10 ** dec) / 10 ** dec, decimals: dec }));
    if (!edits.length) {
      toast('warn', `${layer.label}: no plain numbers to scale (expressions or variables)`);
      return false;
    }
    const ok = ops.setNumbers(edits, `Scale ${layer.label} ×${fmt(f, 3)}`);
    if (ok) {
      reveal(layer.file, layer.lut.arr);
      if (edits.length < cells.length) toast('warn', `${cells.length - edits.length} value(s) of ${layer.label} are expressions or variables: not scaled`);
    }
    return ok;
  }
  const p = layer.prop!;
  const base = p.sources[0];
  const b = typeof p.value === 'number' ? baseFor(p, p.value * f) : null;
  if (b === null || !base) {
    toast('warn', `${layer.label}: can't be worked back through its modifiers`);
    return false;
  }
  if (base.cell.node) {
    const ok = ops.setNumbers([{ file: base.file, node: base.cell.node, value: b, decimals: 3 }], `Scale ${layer.label}`);
    if (ok) reveal(base.file, base.cell.node);
    return ok;
  }
  if (base.cell.varName) {
    ws.setVar(base.cell.varName, b);
    return true;
  }
  return false;
}

function LayerEditor({ layer, active, setPreview, unit, rpmMax }: { layer: PtLayer; active: PtConfig; setPreview: (p: Preview | null) => void; unit: Unit; rpmMax: number }) {
  const usersOf = useContext(UsersCtx);
  const users = usersOf(layer.part);
  const others = users.filter((c) => !c.active);
  const [all, setAll] = useState(editAll.has(layer.part));
  const [busy, setBusy] = useState(false);
  const [scale, setScale] = useState('100');
  const [target, setTarget] = useState('');
  const [metric, setMetric] = useState<'Nm' | 'power'>('power');
  const canWrite = writable(layer.file);
  const unlocked = canWrite && (!others.length || all);
  const copyWhy = cannotCopyFor(layer.part);
  const f = Number(scale) / 100;
  // the scale typed in is previewed on every curve
  useEffect(() => {
    if (Number.isFinite(f) && f > 0 && f !== 1) setPreview({ layer, edit: { kind: 'scale', f } });
    else setPreview(null);
  }, [scale]);
  useEffect(() => () => setPreview(null), []);
  const names = others.map((c) => c.name).join(', ');
  const copy = async () => {
    setBusy(true);
    try {
      await copyPartForConfig(layer.part);
    } finally {
      setBusy(false);
    }
  };
  const copyBtn = (label: string) => (
    <button className="btn small" disabled={!!copyWhy || busy} data-tip={copyWhy ?? `Copies ${layer.part} as a new part, puts it in ${active.name}.pc and edits the copy`} onClick={copy}><Copy size={12} /> {label}</button>
  );
  let scope: React.ReactNode;
  if (!canWrite) scope = <div className="ptp-scope locked"><Lock size={12} /><span><b>{layer.part}</b> is in a game file{others.length ? `; also used by ${names}` : ''}.</span>{copyBtn(`Copy for ${active.name}`)}</div>;
  else if (others.length && !all) scope = (
    <div className="ptp-scope">
      <span><b>{layer.part}</b> is also used by {plural(others.length, 'other configuration')}: {names}.</span>
      <button className="btn small" onClick={() => { editAll.add(layer.part); setAll(true); }}>Edit for all {users.length}</button>
      {copyBtn(`Copy for ${active.name} only`)}
    </div>
  );
  else if (others.length) scope = <div className="ptp-scope ok"><span>Changes apply to {plural(users.length, 'configuration')}: {active.name}, {names}.</span>{copyBtn(`Copy for ${active.name} only`)}</div>;
  else scope = <div className="ptp-scope ok"><span>Only {active.name} uses <b>{layer.part}</b>.</span></div>;

  const solve = () => {
    const t = Number(target);
    if (!(t > 0) || !active.data) return;
    const s = solveLayerScale(active.data, layer, t, metric === 'Nm' ? undefined : (tq, r) => power(unit, tq, r));
    if (s === null) return toast('warn', `${layer.label} alone can't bring ${active.name} to ${t} ${metric === 'Nm' ? 'Nm' : unit}`);
    setScale(String(+(s * 100).toFixed(2)));
  };
  const apply = () => {
    if (!(f > 0) || f === 1) return;
    if (applyScale(layer, f)) setScale('100');
  };
  const lut = layer.lut;
  const xs = lut ? lut.rows.map((r) => r.cells[0]?.value ?? 0) : [];
  const xMax = lut ? (layer.xUnit === 'rpm' ? Math.ceil((Math.max(rpmMax, ...xs) * 1.04) / 500) * 500 : Math.max(...xs, 1) * 1.05) : 0;
  return (
    <div className="ptp-editor">
      {scope}
      {lut && (
        <Chart height={170} xMax={xMax} xUnit={layer.xUnit} lUnit={layer.unit || 'coef'}
          edit={{ lut, xCol: 0, yCol: layer.yCol, axis: 'l', label: `Edit ${layer.label}`, xDec: 0, yDec: yDecOf(layer), locked: !unlocked }}
          dragNote={`${layer.label} · ${layer.part}${unlocked && others.length ? ` · also changes ${names}` : ''}`}
          onDragChange={(d) => setPreview(d ? { layer, edit: { kind: 'point', ...d } } : null)}
          series={(d) => {
            const pts = lut.rows.map((r, i) => (d && d.i === i ? [d.x, d.y] : [r.cells[0]?.value, r.cells[layer.yCol]?.value]) as [number, number]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
            return [{ key: 'layer', label: '', unit: layer.unit, cls: 'mod', values: pts.length >= 2 ? createCurve(pts) : null, axis: 'l' as const }];
          }} />
      )}
      {layer.prop && <div className="ptp-props"><PropRow p={layer.prop} readOnly={!unlocked} /></div>}
      <div className="ptp-under">
        <span className="ptp-scale">
          <span className="dim small-text">Scale</span>
          <input className="input small mono" style={{ width: 64 }} value={scale} disabled={!unlocked} onChange={(ev) => setScale(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') apply(); }} />
          <span className="faint small-text">%</span>
          <button className="btn small primary" disabled={!unlocked || !(f > 0) || f === 1} onClick={apply}>Apply</button>
          {f !== 1 && Number.isFinite(f) && <button className="btn small" onClick={() => setScale('100')}>Reset</button>}
        </span>
        <span className="ptp-scale" data-tip={`Finds the scale of ${layer.label} that gives ${active.name} this peak (shown before you apply it)`}>
          <span className="dim small-text">Peak of {active.name}</span>
          <input className="input small mono" style={{ width: 64 }} value={target} placeholder="target" disabled={!unlocked} onChange={(ev) => setTarget(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') solve(); }} />
          <div className="segmented small">
            <button className={'seg' + (metric === 'power' ? ' active' : '')} style={{ textTransform: 'none' }} onClick={() => setMetric('power')}>{unit}</button>
            <button className={'seg' + (metric === 'Nm' ? ' active' : '')} style={{ textTransform: 'none' }} onClick={() => setMetric('Nm')}>Nm</button>
          </div>
          <button className="btn small" disabled={!unlocked || !(Number(target) > 0)} onClick={solve}>Find scale</button>
        </span>
      </div>
    </div>
  );
}

/** Every configuration's peak torque and power (with the preview), and what its info file says. */
function ConfigsBox({ configs, preview, original, unit }: { configs: PtConfig[]; preview: Preview | null; original: unknown; unit: Unit }) {
  const rows = configs.map((c) => {
    const cv = previewCurves(c, preview, original);
    const pk = (f?: (t: number, r: number) => number) => (cv ? peak(cv.final, f)[0] : NaN);
    const base = (f?: (t: number, r: number) => number) => (c.curves ? peak(c.curves.final, f)[0] : NaN);
    const info = c.key ? readInfo(c.key) : null;
    const infoHp = info?.power && info.power.k === 'num' ? info.power.v : undefined;
    const infoNm = info?.torque && info.torque.k === 'num' ? info.torque.v : undefined;
    // as the game writes them (dynamicVehicleData.lua): hp floored, Nm rounded up to 5
    const hp = Math.floor(base((t, r) => HP(kW(t, r)))), nm = Math.ceil(base() / 5) * 5;
    const stale = !!info?.writable && Number.isFinite(hp) && (infoHp !== hp || infoNm !== nm);
    const ind = c.data ? [c.data.turbo && 'turbo', c.data.sc && 'SC', c.data.n2o && 'N2O'].filter(Boolean).join(' + ') || 'NA' : '—';
    return { c, pw: pk((t, r) => power(unit, t, r)), nm: pk(), hp, nmBase: nm, info, infoHp, infoNm, stale, changed: cv !== c.curves, ind };
  });
  const stale = rows.filter((r) => r.stale);
  return (
    <section className="ptp-box wide">
      <header>
        <span className="panel-title">Configurations</span>
        <div className="grow" />
        {stale.length > 0 && (
          <button className="btn small" data-tip="Writes Power (hp) and Torque (Nm), the numbers the vehicle selector shows, into each info_*.json"
            onClick={() => writeInfo(stale.map((r) => ({ pcKey: r.c.key, hp: r.hp, nm: r.nmBase })))}>Update {plural(stale.length, 'info file')}</button>
        )}
      </header>
      <div className="ptp-cfgs">
        <span className="faint small-text">config</span><span className="faint small-text">boost</span><span className="faint small-text r">{unit}</span><span className="faint small-text r">Nm</span><span className="faint small-text r" data-tip="Power (hp) / Torque (Nm) in info_*.json">info</span>
        {rows.map((r) => (
          <div key={r.c.key || r.c.name} className={'ptp-cfg' + (r.c.active ? ' active' : '') + (r.changed ? ' changed' : '')}
            onClick={() => { if (!r.c.active && r.c.key) ws.setActiveConfig(r.c.key); }} data-tip={r.c.active ? 'Shown' : `Show ${r.c.name}`}>
            <span className="ellipsis">{r.c.name}</span>
            <span className="faint small-text">{r.ind}</span>
            <span className="mono r">{fmt(r.pw, 0)}</span>
            <span className="mono r">{fmt(r.nm, 0)}</span>
            <span className={'mono r small-text ' + (r.stale ? 'warn' : 'faint')} data-tip={r.stale ? `The info file says ${r.infoHp ?? '—'} hp / ${r.infoNm ?? '—'} Nm; the game would write ${fmt(r.hp, 0)} hp / ${fmt(r.nmBase, 0)} Nm` : undefined}>
              {r.info ? `${r.infoHp ?? '—'} / ${r.infoNm ?? '—'}` : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// gearbox
// ---------------------------------------------------------------------------------------------

function GearboxBox({ g, drives, final, maxRpm, radius }: { g: PtGearbox; drives: PtFinalDrive[]; final: number; maxRpm: number; radius: number }) {
  const forward = g.ratios.map((r, i) => ({ r, i })).filter(({ r }) => r.value > 0);
  const names = g.ratios.map((r, i) => (r.value < 0 ? 'R' : r.value === 0 ? 'N' : String(g.ratios.slice(0, i + 1).filter((x) => x.value > 0).length)));
  const vMax = Math.max(50, ...forward.map(({ r }) => roadSpeed(maxRpm, r.value, final, radius))) * 1.08;
  const gsvg = useRef<SVGSVGElement>(null);
  const GW = useWidth(gsvg, 360), GH = 170, gl = 40, gr = 10, gt = 10, gb = 22;
  const X = (kmh: number) => gl + (kmh / vMax) * (GW - gl - gr);
  const Y = (rpm: number) => GH - gb - (rpm / (maxRpm * 1.05)) * (GH - gt - gb);
  const canEdit = writable(g.file);
  return (
    <section className="ptp-box">
      <header>
        <span className="panel-title">Gearbox</span>
        <span className="faint mono small-text ellipsis" data-tip={`${g.name} · ${g.type}`}>{g.type}</span>
        <button className="ptp-src" onClick={() => reveal(g.file, g.array)}>{g.part}</button>
      </header>
      <div className="ptp-gears">
        <span className="faint small-text">gear</span><span className="faint small-text">ratio</span><span className="faint small-text" data-tip={`At ${fmt(maxRpm, 0)} rpm, final drive ${fmt(final, 2)}, wheel radius ${fmt(radius, 3)} m`}>km/h</span>
        {g.ratios.map((r, i) => (
          <div key={i} className="ptp-gear">
            <span className="mono dim">{names[i]}</span>
            <CellField c={r} label={`Gear ${names[i]} ratio`} decimals={3} width={70} />
            <span className="mono faint">{r.value > 0 ? fmt(roadSpeed(maxRpm, r.value, final, radius), 0) : ''}</span>
          </div>
        ))}
        {drives.map((d) => (
          <div key={d.name + d.part} className="ptp-gear fd">
            <span className="mono dim" data-tip={`${d.name} · ${d.part}`}>FD</span>
            <CellField c={{ ...d.ratio, file: d.ratio.file ?? d.file }} label="Final drive" decimals={3} width={70} />
            <button className="ptp-src" onClick={() => reveal(d.file, d.ratio.node)}>{d.name}</button>
          </div>
        ))}
      </div>
      {g.array && canEdit && (
        <div className="ptp-under">
          <button className="btn small" onClick={() => {
            const last = forward[forward.length - 1]?.r.value ?? 1;
            if (ops.arrayPush(g.file, g.array!, Math.round(last * 0.8 * 1000) / 1000, 'Add gear')) reveal(g.file, g.array);
          }}><Plus size={12} /> Gear</button>
          <button className="btn small" disabled={forward.length < 2} onClick={() => {
            if (ops.arrayPush(g.file, g.array!, null, 'Remove gear')) reveal(g.file, g.array);
          }}><Minus size={12} /> Last gear</button>
        </div>
      )}
      <svg ref={gsvg} className="ptp-chart" viewBox={`0 0 ${GW} ${GH}`} style={{ height: GH }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f} className="ptp-grid"><line x1={gl} x2={GW - gr} y1={Y(maxRpm * f)} y2={Y(maxRpm * f)} /><text x={gl - 6} y={Y(maxRpm * f) + 4} textAnchor="end">{fmt(maxRpm * f / 1000, 1)}k</text></g>)}
        {niceTicks(0, vMax, 4).filter((v) => X(v) < GW - gr - 34).map((v) => <text key={'v' + v} className="ptp-grid" x={X(v)} y={GH - 6} textAnchor="middle">{v}</text>)}
        <text className="ptp-axis" x={GW - gr} y={GH - 6} textAnchor="end">km/h</text>
        {forward.map(({ r, i }, k) => {
          const top = roadSpeed(maxRpm, r.value, final, radius);
          return (
            <g key={i} className="ptp-gear-line" style={{ ['--k' as any]: k }}>
              <line x1={X(0)} y1={Y(0)} x2={X(top)} y2={Y(maxRpm)} />
              <text x={X(top) - 4} y={Y(maxRpm) - 4} textAnchor="end">{names[i]}</text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
