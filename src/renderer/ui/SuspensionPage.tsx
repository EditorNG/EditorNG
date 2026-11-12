import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw, Info, AlertTriangle, RotateCcw } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi } from '../state/ui';
import { useSettings } from '../state/settings';
import { analyzeSuspension, SuspModel, type SuspResult, type AxleResult, type CornerStatic } from '@core/analysis/suspension';
import { massReport } from '@core/analysis/debug';
import { LineChart, SERIES_COLORS, type Series } from './LineChart';
import type { Vehicle } from '@core/jbeam/types';

const f = (x: number | null | undefined, d = 2, unit = '') => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d) + unit);

function useDark() {
  const theme = useSettings((x) => x.s.theme);
  return theme !== 'light';
}

export default function SuspensionPage() {
  const v = useWs((x) => x.vehicle);
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const [forceFree, setForceFree] = useState<string[]>([]);
  const [forceFixed, setForceFixed] = useState<string[]>([]);
  const [brakeF, setBrakeF] = useState(0.65);
  const [res, setRes] = useState<SuspResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [axleTab, setAxleTab] = useState<'front' | 'rear'>('front');
  const dark = useDark();
  const colors = dark ? SERIES_COLORS.dark : SERIES_COLORS.light;

  useEffect(() => {
    if (!v) return;
    setBusy(true);
    const t = setTimeout(() => {
      try {
        const cog = massReport(v).cog[2];
        setRes(analyzeSuspension(v, { rigidThreshold: s.suspRigidThreshold, partPattern: s.suspPartPattern, travel: s.suspTravel, steps: s.suspSteps, forceFree, forceFixed, frontBrakeFraction: brakeF }, cog));
      } finally {
        setBusy(false);
      }
    }, 30);
    return () => clearTimeout(t);
  }, [v, s.suspRigidThreshold, s.suspPartPattern, s.suspTravel, s.suspSteps, forceFree, forceFixed, brakeF]);

  if (!v) return <div className="empty-hint">Open a vehicle to analyse its suspension.</div>;
  const axle = res?.axles.find((a) => a.axle === axleTab) ?? res?.axles[0];

  return (
    <div className="page-inner susp">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="icon-btn" onClick={() => useUi.setState({ page: 'workbench' })} aria-label="Back"><ArrowLeft size={18} /></button>
        <div>
          <div className="page-title">Suspension analysis</div>
          <div className="page-sub">Kinematics solved from the beams themselves — works for any layout. Changes in the editor and tuning sliders update live.</div>
        </div>
        <div className="grow" />
        {busy && <RefreshCw size={16} className="spin faint" />}
      </div>

      {res && res.warnings.length > 0 && (
        <div className="card warn-card">{res.warnings.map((w, i) => <div key={i} className="row"><AlertTriangle size={14} className="warn-text" /> {w}</div>)}</div>
      )}

      <div className="susp-grid">
        <div className="susp-side">
          <div className="card">
            <div className="card-title">Model</div>
            <label className="tf-row"><span className="tf-label">rigid ≥ N/m</span><input className="input small mono grow" type="number" step={100000} value={s.suspRigidThreshold} onChange={(e) => set({ suspRigidThreshold: +e.target.value })} /></label>
            <label className="tf-row"><span className="tf-label">travel ± m</span><input className="input small mono grow" type="number" step={0.01} value={s.suspTravel} onChange={(e) => set({ suspTravel: Math.max(0.005, +e.target.value) })} /></label>
            <label className="tf-row"><span className="tf-label">steps</span><input className="input small mono grow" type="number" value={s.suspSteps} onChange={(e) => set({ suspSteps: Math.max(3, Math.min(61, +e.target.value | 0)) })} /></label>
            <label className="tf-row"><span className="tf-label">front brake</span><input className="input small mono grow" type="number" step={0.05} value={brakeF} onChange={(e) => setBrakeF(+e.target.value)} /></label>
            <label className="field" style={{ marginTop: 6 }}><span className="field-label">Moving parts pattern (regex on part name / slotType)</span><input className="input small mono" value={s.suspPartPattern} onChange={(e) => set({ suspPartPattern: e.target.value })} /></label>
            {res && (
              <div className="faint small-text">
                {res.freeNodes} moving nodes · {res.rigidBeams} rigid links · {res.compliantBeams} springs/dampers/stops ignored · residual {(res.residual * 1000).toFixed(2)} mm
              </div>
            )}
          </div>
          {res && <PartsCard v={v} res={res} forceFree={forceFree} forceFixed={forceFixed} setForceFree={setForceFree} setForceFixed={setForceFixed} />}
          <TuningCard v={v} />
        </div>

        <div className="susp-main">
          {res && (
            <div className="susp-summary">
              <Stat label="wheelbase" value={f(res.wheelbase, 3, ' m')} />
              {res.axles.map((a) => <Stat key={a.axle} label={`${a.axle} track`} value={f(a.track, 3, ' m')} />)}
              {res.axles.map((a) => <Stat key={'rc' + a.axle} label={`${a.axle} roll centre`} value={a.rollCenter ? f(a.rollCenter[1] * 1000, 0, ' mm') : '—'} />)}
              <Stat label="anti-dive" value={f(res.antiDive, 0, ' %')} hint={`static, ${Math.round(brakeF * 100)}% front brake, COG ${f(res.cogHeight, 2)} m`} />
              <Stat label="anti-squat" value={f(res.antiSquat, 0, ' %')} hint="rear, from side-view instant centre" />
              {res.steering && <Stat label="Ackermann" value={f(res.steering.ackermannPct, 0, ' %')} hint="100% = ideal; <0 = outer wheel steers more (anti-Ackermann)" />}
            </div>
          )}
          {res && res.axles.length > 1 && (
            <div className="segmented" style={{ marginBottom: 10 }}>
              {res.axles.map((a) => <button key={a.axle} className={'seg' + (axle?.axle === a.axle ? ' active' : '')} onClick={() => setAxleTab(a.axle)}>{a.axle} axle</button>)}
            </div>
          )}
          {axle && <AxleView axle={axle} colors={colors} v={v} />}
          {res?.steering && axleTab === 'front' && (
            <div className="card">
              <div className="card-title">Steering</div>
              <div className="charts">
                <LineChart
                  title="Wheel angle vs steering input"
                  x={res.steering.input}
                  xLabel="steering input"
                  yLabel="wheel yaw (°)"
                  xFmt={(x) => x.toFixed(1)}
                  yFmt={(y) => y.toFixed(0)}
                  zeroLine
                  series={[
                    { name: 'left', values: res.steering.left, color: colors[0] },
                    { name: 'right', values: res.steering.right, color: colors[1] },
                  ]}
                />
                <LineChart
                  title="Inner wheel vs ideal Ackermann"
                  x={res.steering.input.slice(20)}
                  xLabel="steering input (right turn)"
                  yLabel="inner wheel (°)"
                  xFmt={(x) => x.toFixed(1)}
                  yFmt={(y) => y.toFixed(0)}
                  series={[
                    { name: 'actual', values: res.steering.right.slice(20).map(Math.abs), color: colors[0] },
                    { name: 'ideal', values: res.steering.ideal.slice(20).map(Math.abs), color: 'var(--text-faint)', dashed: true },
                  ]}
                />
              </div>
              <div className="faint small-text">{res.steering.hydros} steering hydro(s) driven over input −1…+1 (positive = right turn). Max lock L {f(res.steering.maxLeft, 1)}° / R {f(res.steering.maxRight, 1)}°.</div>
            </div>
          )}
          {!res && <div className="empty-hint">Solving…</div>}
        </div>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat card" title={props.hint}>
      <div className="stat-v">{props.value}</div>
      <div className="stat-l">{props.label}{props.hint && <Info size={10} style={{ marginLeft: 4, verticalAlign: -1 }} />}</div>
    </div>
  );
}

function cornerSeries(axle: AxleResult, key: 'camber' | 'toe' | 'trackChange' | 'wheelbaseChange', colors: string[]): Series[] {
  const sorted = [...axle.corners].sort((a, b) => b.corner.side - a.corner.side);
  return sorted.map((c, i) => ({ name: c.corner.name, values: axle.curves[c.corner.name][key], color: colors[i % 2] }));
}

function AxleView({ axle, colors, v }: { axle: AxleResult; colors: string[]; v: Vehicle }) {
  const travel = axle.corners[0] ? axle.curves[axle.corners[0].corner.name].travel.map((t) => t * 1000) : [];
  return (
    <>
      <div className="card">
        <div className="card-title">{axle.axle === 'front' ? 'Front' : 'Rear'} axle — static</div>
        <table className="data-table">
          <thead>
            <tr><th>corner</th><th>camber °</th><th>toe °</th><th>caster °</th><th>KPI °</th><th>scrub mm</th><th>trail mm</th><th>front-view IC (x, z)</th><th>spring MR</th><th>wheel rate N/m</th></tr>
          </thead>
          <tbody>
            {axle.corners.map((c) => <CornerRow key={c.corner.name} c={c} />)}
          </tbody>
        </table>
        <div className="faint small-text" style={{ marginTop: 6 }}>
          Camber + = top outward; toe + = toe-in; caster + = axis top rearward; KPI + = axis top inboard; scrub + = contact patch outboard of the steering axis. Steering axis from {axle.corners.some((c) => c.steerAxisSource === 'jbeam') ? <span className="mono">steerAxisUp/Down</span> : 'the hub motion under steering'}.
        </div>
      </div>
      <div className="card">
        <div className="card-title">Heave sweep (both wheels together)</div>
        <div className="charts">
          <LineChart title="Camber gain" x={travel} xLabel="wheel travel (mm, + = bump)" yLabel="camber (°)" xFmt={(x) => x.toFixed(0)} zeroLine series={cornerSeries(axle, 'camber', colors)} />
          <LineChart title="Bump steer" x={travel} xLabel="wheel travel (mm, + = bump)" yLabel="toe (°)" xFmt={(x) => x.toFixed(0)} zeroLine series={cornerSeries(axle, 'toe', colors)} />
          <LineChart title="Roll centre height" x={travel} xLabel="wheel travel (mm, + = bump)" yLabel="RC height (mm)" xFmt={(x) => x.toFixed(0)} yFmt={(y) => y.toFixed(0)} series={[{ name: 'roll centre', values: axle.rcCurve.height.map((h) => h * 1000), color: colors[0] }]} />
          <LineChart title="Track change (half track)" x={travel} xLabel="wheel travel (mm, + = bump)" yLabel="Δ contact x (mm)" xFmt={(x) => x.toFixed(0)} yFmt={(y) => y.toFixed(1)} zeroLine series={cornerSeries(axle, 'trackChange', colors)} />
        </div>
      </div>
      <FrontView axle={axle} v={v} colors={colors} />
      <SpringTable axle={axle} />
    </>
  );
}

function CornerRow({ c }: { c: CornerStatic }) {
  const sp = c.springs.find((x) => x.kind === 'spring') ?? c.springs[0];
  return (
    <tr>
      <td className="mono">{c.corner.name}</td>
      <td>{f(c.camber)}</td>
      <td>{f(c.toe)}</td>
      <td>{f(c.caster)}</td>
      <td>{f(c.kpi)}</td>
      <td>{f(c.scrub !== null ? c.scrub * 1000 : null, 0)}</td>
      <td>{f(c.trail !== null ? c.trail * 1000 : null, 0)}</td>
      <td className="mono">{c.ic ? `${c.ic[0].toFixed(2)}, ${c.ic[1].toFixed(2)}` : '∞'}</td>
      <td>{sp ? f(sp.motionRatio, 2) : '—'}</td>
      <td>{sp ? f(sp.wheelRate, 0) : '—'}</td>
    </tr>
  );
}

function SpringTable({ axle }: { axle: AxleResult }) {
  return (
    <div className="card">
      <div className="card-title">Springs, dampers &amp; stops acting on the wheels</div>
      <table className="data-table">
        <thead><tr><th>corner</th><th>beam</th><th>kind</th><th>beamSpring</th><th>beamDamp</th><th>motion ratio</th><th>wheel rate</th></tr></thead>
        <tbody>
          {axle.corners.flatMap((c) => c.springs.map((s) => (
            <tr key={c.corner.name + s.beam}>
              <td className="mono">{c.corner.name}</td>
              <td className="mono">{s.name}</td>
              <td>{s.kind}</td>
              <td>{s.k ? s.k.toLocaleString() : '—'}</td>
              <td>{s.damp ? s.damp.toLocaleString() : '—'}</td>
              <td>{s.motionRatio.toFixed(3)}</td>
              <td>{s.wheelRate ? Math.round(s.wheelRate).toLocaleString() : '—'}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <div className="faint small-text" style={{ marginTop: 6 }}>Motion ratio = beam length change per wheel travel (from the solved kinematics). Wheel rate = beamSpring × MR².</div>
    </div>
  );
}

/** Front-view diagram: moving nodes, rigid links, wheel outlines, instant-centre lines and roll centre. */
function FrontView({ axle, v, colors }: { axle: AxleResult; v: Vehicle; colors: string[] }) {
  const s = useSettings((x) => x.s);
  const model = useMemo(() => new SuspModel(v, { rigidThreshold: s.suspRigidThreshold, partPattern: s.suspPartPattern, travel: s.suspTravel, steps: 3 }), [v, s.suspRigidThreshold, s.suspPartPattern]);
  const ys = axle.corners.map((c) => c.corner.center[1]);
  const yMid = ys.reduce((a, b) => a + b, 0) / (ys.length || 1);
  const near = (i: number) => Math.abs(model.pos[i * 3 + 1] - yMid) < 0.45;
  const lines: Array<[number, number, number, number]> = [];
  for (const c of model.cons) {
    if (!model.free[c.a] && !model.free[c.b]) continue;
    if (!near(c.a) || !near(c.b)) continue;
    lines.push([model.pos[c.a * 3], model.pos[c.a * 3 + 2], model.pos[c.b * 3], model.pos[c.b * 3 + 2]]);
  }
  const ground = Math.min(...axle.corners.map((c) => c.corner.contact[2]));
  const halfW = Math.max(1, ...axle.corners.map((c) => Math.abs(c.corner.center[0]) + 0.3));
  const W = 640, H = 300;
  const scale = Math.min((W - 20) / (halfW * 2), (H - 20) / 1.6);
  const X = (x: number) => W / 2 + x * scale;
  const Z = (z: number) => H - 20 - (z - ground) * scale;
  const rc = axle.rollCenter;
  return (
    <div className="card">
      <div className="card-title">Front view — {axle.axle} axle</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="front-view" role="img" aria-label="Front view of the suspension geometry">
        <line x1={0} x2={W} y1={Z(ground)} y2={Z(ground)} className="fv-ground" />
        <line x1={W / 2} x2={W / 2} y1={10} y2={H - 10} className="fv-center" />
        {lines.map((l, i) => <line key={i} x1={X(l[0])} y1={Z(l[1])} x2={X(l[2])} y2={Z(l[3])} className="fv-link" />)}
        {axle.corners.map((c, i) => {
          const col = colors[c.corner.side === 1 ? 0 : 1];
          const cx = c.corner.center[0], cz = c.corner.center[2];
          const r = c.corner.radius;
          const w = 0.11;
          return (
            <g key={c.corner.name}>
              <rect x={X(cx - w)} y={Z(cz + r)} width={2 * w * scale} height={2 * r * scale} rx={6} className="fv-wheel" style={{ stroke: col }} />
              <circle cx={X(c.corner.contact[0])} cy={Z(c.corner.contact[2])} r={4} fill={col} />
              {c.ic && (
                <>
                  <line x1={X(c.corner.contact[0])} y1={Z(c.corner.contact[2])} x2={X(c.ic[0])} y2={Z(c.ic[1])} className="fv-icline" style={{ stroke: col }} />
                  <circle cx={X(c.ic[0])} cy={Z(c.ic[1])} r={4} fill="none" stroke={col} strokeWidth={2} />
                  <text x={X(c.ic[0]) + 6} y={Z(c.ic[1]) - 6} className="chart-tick">IC {c.corner.name}</text>
                </>
              )}
              <text x={X(cx)} y={Z(cz + r) - 6} className="chart-tick" textAnchor="middle">{c.corner.name}{i === 0 ? '' : ''}</text>
            </g>
          );
        })}
        {rc && (
          <g>
            <circle cx={X(rc[0])} cy={Z(ground + rc[1])} r={6} fill="var(--accent)" stroke="var(--bg-2)" strokeWidth={2} />
            <text x={X(rc[0]) + 9} y={Z(ground + rc[1]) + 4} className="chart-end-label">RC {(rc[1] * 1000).toFixed(0)} mm</text>
          </g>
        )}
      </svg>
      <div className="faint small-text">Moving rigid links within ±45 cm of the axle, projected on the front plane. Lines run from each contact patch through its instant centre; they cross at the roll centre.</div>
    </div>
  );
}

function PartsCard(props: { v: Vehicle; res: SuspResult; forceFree: string[]; forceFixed: string[]; setForceFree: (x: string[]) => void; setForceFixed: (x: string[]) => void }) {
  const [show, setShow] = useState(false);
  const parts = props.v.parts.filter((p) => p.def.sections.has('nodes'));
  const isFree = (n: string) => props.res.freeParts.includes(n);
  return (
    <div className="card">
      <div className="card-title">Moving parts <span className="badge">{props.res.freeParts.length}</span>
        <button className="btn small ghost" onClick={() => setShow(!show)}>{show ? 'hide' : 'edit'}</button>
      </div>
      {!show && <div className="faint small-text">{props.res.freeParts.slice(0, 8).join(', ')}{props.res.freeParts.length > 8 ? '…' : ''}</div>}
      {show && (
        <div className="parts-list">
          {parts.map((p) => {
            const n = p.def.name;
            const on = isFree(n);
            return (
              <label key={n} className="row small-text">
                <input type="checkbox" checked={on} onChange={() => {
                  if (on) {
                    props.setForceFree(props.forceFree.filter((x) => x !== n));
                    props.setForceFixed([...props.forceFixed.filter((x) => x !== n), n]);
                  } else {
                    props.setForceFixed(props.forceFixed.filter((x) => x !== n));
                    props.setForceFree([...props.forceFree.filter((x) => x !== n), n]);
                  }
                }} />
                <span className="mono ellipsis">{n}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TUNING_RE = /spring|damp|bump|rebound|camber|toe|caster|arb|sway|ride|height|offset|track|wheel|tire|tyre|pressure|steer|alignment|suspension/i;

function TuningCard({ v }: { v: Vehicle }) {
  const vars = v.variables.filter((x) => TUNING_RE.test(x.name) || TUNING_RE.test(x.category ?? '') || TUNING_RE.test(x.title ?? ''));
  if (!vars.length) return null;
  return (
    <div className="card">
      <div className="card-title">Tuning (live)</div>
      {vars.map((x) => {
        const lo = Math.min(x.min, x.max), hi = Math.max(x.min, x.max);
        return (
          <div key={x.name} className="tune-row" title={`${x.name} (${x.part})`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="ellipsis small-text">{x.title || x.name}</span>
              <span className="mono small-text">{+x.val.toPrecision(5)}{x.unit && x.unit !== '%' ? ' ' + x.unit : ''}
                {x.val !== x.default && <button className="icon-btn small tiny" onClick={() => ws.setVar(x.name, undefined)} aria-label="Reset"><RotateCcw size={10} /></button>}
              </span>
            </div>
            <input type="range" min={lo} max={hi} step={(hi - lo) / 200 || 0.001} value={x.val} onChange={(e) => ws.setVar(x.name, +e.target.value)} style={{ width: '100%' }} />
          </div>
        );
      })}
    </div>
  );
}
