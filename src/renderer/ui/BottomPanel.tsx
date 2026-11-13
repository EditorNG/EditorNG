import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Lightbulb, X, Play, Wrench, RotateCcw } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, type BottomTab } from '../state/ui';
import { useSettings, settings } from '../state/settings';
import { revealRange } from '../editor/CodeEditor';
import { CHECKS, massReport, type Finding } from '@core/analysis/debug';
import { useChecks, runAllChecks, setCheckEnabled } from '../state/checks';
import { openMenu } from './Menu';
import { GameLogTab } from './GameLink';
import { emptySel, setSel, type Sel } from '../state/selection';
import { getViewport } from '../scene/ViewportPanel';
import * as ops from '../project/ops';
import { deleteNodes } from '@core/jbeam/edit';
import type { ANode } from '@core/sjson';
import type { Vehicle } from '@core/jbeam/types';

const SEV_ICON = {
  error: <AlertCircle size={13} className="err-text" />,
  warning: <AlertTriangle size={13} className="warn-text" />,
  info: <Info size={13} className="info-text" />,
  hint: <Lightbulb size={13} className="faint" />,
};

export function BottomPanel() {
  const tab = useUi((x) => x.bottomTab);
  const v = useWs((x) => x.vehicle);
  const counts = useMemo(() => {
    const c = { error: 0, warning: 0 };
    for (const i of v?.issues ?? []) {
      if (i.sev === 'error') c.error++;
      else if (i.sev === 'warning') c.warning++;
    }
    return c;
  }, [v]);
  const tabBtn = (t: BottomTab, label: React.ReactNode) => (
    <button className={'btab' + (tab === t ? ' active' : '')} onClick={() => useUi.setState({ bottomTab: t })}>{label}</button>
  );
  return (
    <div className="bottom-panel">
      <div className="btabs">
        {tabBtn('problems', <>Problems {counts.error > 0 && <span className="badge err">{counts.error}</span>} {counts.warning > 0 && <span className="badge warn">{counts.warning}</span>}</>)}
        {tabBtn('debug', <>Checks <ChecksBadge /></>)}
        {tabBtn('gamelog', 'Game log')}
        {tabBtn('mass', 'Weight')}
        {tabBtn('variables', 'Tuning')}
        {tabBtn('output', 'Output')}
        <div className="grow" />
        <button className="icon-btn small" onClick={() => useUi.setState({ bottom: false })} aria-label="Close panel"><X size={14} /></button>
      </div>
      <div className="bpanel-body">
        {tab === 'problems' && <Problems />}
        {tab === 'debug' && <Checks />}
        {tab === 'gamelog' && <GameLogTab />}
        {tab === 'mass' && <Mass />}
        {tab === 'variables' && <Variables />}
        {tab === 'output' && <Output />}
      </div>
    </div>
  );
}

function Problems() {
  const v = useWs((x) => x.vehicle);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [showInfo, setShowInfo] = useState(false);
  const list = useMemo(() => {
    const out = (v?.issues ?? []).filter((i) => (filter === 'all' ? (showInfo ? true : i.sev === 'error' || i.sev === 'warning') : i.sev === filter));
    const rank = { error: 0, warning: 1, info: 2, hint: 3 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]).slice(0, 2000);
  }, [v, filter, showInfo]);
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="bpanel-tools">
        <div className="segmented small">
          {(['all', 'error', 'warning'] as const).map((f) => (
            <button key={f} className={'seg' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <label className="row dim"><button className={'switch' + (showInfo ? ' on' : '')} onClick={() => setShowInfo(!showInfo)} aria-label="Show info" /> info &amp; hints</label>
        <span className="faint">{list.length} shown</span>
      </div>
      <div className="list-scroll">
        {list.map((i, k) => {
          const d = i.file ? ws.doc(i.file) : undefined;
          return (
            <button key={k} className="problem" onClick={() => i.file && i.s !== undefined && revealRange(i.file, i.s, i.e ?? i.s, true)} onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                { label: 'Go to code', disabled: i.file && i.s !== undefined ? false : 'No source position', run: () => i.file && i.s !== undefined && revealRange(i.file, i.s, i.e ?? i.s, true) },
                { label: 'Copy message', run: () => navigator.clipboard.writeText(i.msg) },
              ]);
            }}>
              {SEV_ICON[i.sev]}
              <span className="ellipsis grow">{i.msg}</span>
              <span className="faint ellipsis small-text" style={{ maxWidth: 260 }}>{d ? d.name : ''}{i.part ? ` · ${i.part}` : ''}</span>
            </button>
          );
        })}
        {!list.length && <div className="empty-hint">No problems. 🎉</div>}
      </div>
    </div>
  );
}

function selectFinding(v: Vehicle, f: Finding) {
  const s: Sel = emptySel();
  for (const i of f.nodes ?? []) s.nodes.add(v.nodes[i].name);
  setSel(s);
  if (f.nodes?.length) getViewport()?.frameNodes(f.nodes);
  if (f.src) {
    revealRange(f.src.file, f.src.s, f.src.e);
    return;
  }
  const row = f.beams?.length ? v.beams[f.beams[0]].row : f.tris?.length ? v.tris[f.tris[0]].row : f.nodes?.length ? v.nodes[f.nodes[0]].row : null;
  if (row) revealRange(row.src.file, row.src.node.s, row.src.node.e);
}

function fixFinding(v: Vehicle, f: Finding) {
  const rows: Array<{ file: string; node: ANode }> = [];
  if (f.fix === 'deleteBeams') for (const i of (f.beams ?? []).slice(1)) rows.push({ file: v.beams[i].row.src.file, node: v.beams[i].row.src.node });
  if (f.fix === 'deleteTris') for (const i of (f.tris ?? []).slice(1)) rows.push({ file: v.tris[i].row.src.file, node: v.tris[i].row.src.node });
  return rows;
}

function Checks() {
  const v = useWs((x) => x.vehicle);
  const enabled = useChecks((x) => x.enabled);
  const res = useChecks((x) => x.results);
  const [active, setActive] = useState<string | null>(null);
  const run = () => {
    if (v) runAllChecks();
  };
  const byCheck = new Map<string, Finding[]>();
  for (const f of res ?? []) {
    let l = byCheck.get(f.check);
    if (!l) byCheck.set(f.check, (l = []));
    l.push(f);
  }
  const fixOne = (f: Finding) => {
    if (!v) return;
    if (f.fix === 'snapRail') {
      if (ops.snapToRails(f.nodes ?? [])) setTimeout(run, 50);
      return;
    }
    const rows = fixFinding(v, f);
    const map = new Map<string, ANode[]>();
    for (const r of rows) (map.get(r.file) ?? map.set(r.file, []).get(r.file)!).push(r.node);
    const edits = new Map([...map].map(([file, nodes]) => [file.toLowerCase(), deleteNodes(ws.doc(file)!.text, nodes)]));
    if (ops.applyRaw('Fix finding', edits)) setTimeout(run, 50);
  };
  const fixAll = (id: string) => {
    if (!v) return;
    const snaps = (byCheck.get(id) ?? []).filter((f) => f.fix === 'snapRail').flatMap((f) => f.nodes ?? []);
    if (snaps.length) {
      if (ops.snapToRails(snaps)) setTimeout(run, 50);
      return;
    }
    const rows = (byCheck.get(id) ?? []).flatMap((f) => fixFinding(v, f));
    const map = new Map<string, ANode[]>();
    for (const r of rows) (map.get(r.file) ?? map.set(r.file, []).get(r.file)!).push(r.node);
    const edits = new Map([...map].map(([file, nodes]) => [file.toLowerCase(), deleteNodes(ws.doc(file)!.text, nodes)]));
    if (ops.applyRaw(`Fix ${id}`, edits)) setTimeout(run, 50);
  };
  const shown = active ? CHECKS.filter((c) => c.id === active) : CHECKS.filter((c) => byCheck.has(c.id));
  return (
    <div className="checks">
      <div className="checks-left">
        <button className="btn primary small" onClick={run} disabled={!v}><Play size={12} /> Run checks</button>
        {CHECKS.map((c) => (
          <div key={c.id} className={'check-row' + (active === c.id ? ' active' : '')} title={c.doc}>
            <button className={'switch' + (enabled.has(c.id) ? ' on' : '')} onClick={() => setCheckEnabled(c.id, !enabled.has(c.id))} aria-label={c.title} />
            <button className="check-name" onClick={() => setActive(active === c.id ? null : c.id)}>{c.title}</button>
            {res && <span className={'badge' + ((byCheck.get(c.id)?.length ?? 0) ? ' warn' : '')}>{byCheck.get(c.id)?.length ?? 0}</span>}
          </div>
        ))}
      </div>
      <div className="list-scroll grow">
        {!res && <div className="empty-hint">Pick the checks on the left and press <b>Run checks</b>. Click a finding to select it in 3D and in code.</div>}
        {res && !res.length && <div className="empty-hint">No findings. 🎉</div>}
        {res && shown.map((c) => {
          const list = byCheck.get(c.id) ?? [];
          if (!list.length) return null;
          const fixable = list.some((f) => f.fix);
          return (
            <div key={c.id}>
              <div className="group-label">
                {c.title} <span className="badge">{list.length}</span>
                {fixable && <button className="btn small ghost" onClick={() => fixAll(c.id)}><Wrench size={12} /> {c.id === 'rails' ? 'Snap onto rails' : 'Remove extras'}</button>}
              </div>
              {list.slice(0, 500).map((f, k) => (
                <button key={k} className="problem" onClick={() => v && selectFinding(v, f)} onContextMenu={(e) => {
                  e.preventDefault();
                  if (!v) return;
                  openMenu(e.clientX, e.clientY, [
                    { label: 'Select in 3D', run: () => selectFinding(v, f) },
                    f.fix && { label: f.fix === 'snapRail' ? 'Snap onto rail' : 'Remove the extras', run: () => fixOne(f) },
                    'sep',
                    { label: `Don't run "${c.title}"`, run: () => setCheckEnabled(c.id, false) },
                    { label: 'Copy message', run: () => navigator.clipboard.writeText(f.msg) },
                  ]);
                }}>
                  {SEV_ICON[f.sev]}
                  <span className="ellipsis grow mono">{f.msg}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Mass() {
  const v = useWs((x) => x.vehicle);
  const r = useMemo(() => (v ? massReport(v) : null), [v]);
  if (!v || !r) return <div className="empty-hint">Open a vehicle.</div>;
  const pct = (a: number) => (r.total ? ((a / r.total) * 100).toFixed(1) : '0');
  const max = r.byPart[0]?.mass ?? 1;
  return (
    <div className="mass">
      <div className="mass-summary">
        <div className="stat"><div className="stat-v">{r.total.toFixed(1)} <small>kg</small></div><div className="stat-l">node mass</div></div>
        <div className="stat"><div className="stat-v">{pct(r.front)} / {pct(r.rear)}</div><div className="stat-l">front / rear %</div></div>
        <div className="stat"><div className="stat-v">{pct(r.left)} / {pct(r.right)}</div><div className="stat-l">left / right %</div></div>
        <div className="stat"><div className="stat-v mono">{r.cog.map((x) => x.toFixed(3)).join(', ')}</div><div className="stat-l">centre of gravity (x, y, z)</div></div>
        <div className="faint small-text" style={{ maxWidth: 360 }}>Node mass only: powertrain, fuel and other masses added by Lua at spawn are not included. Axle split is a static moment balance between the outermost axles.</div>
      </div>
      <div className="list-scroll grow">
        {r.byPart.map((p) => (
          <div key={p.part} className="mass-row">
            <span className="mono ellipsis" style={{ width: 280 }}>{p.part}</span>
            <div className="bar"><div style={{ width: `${(p.mass / max) * 100}%` }} /></div>
            <span className="mono" style={{ width: 90, textAlign: 'right' }}>{p.mass.toFixed(2)} kg</span>
            <span className="faint" style={{ width: 70, textAlign: 'right' }}>{p.nodes} nodes</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Variables() {
  const v = useWs((x) => x.vehicle);
  const [q, setQ] = useState('');
  if (!v) return <div className="empty-hint">Open a vehicle.</div>;
  const list = v.variables.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()) || (x.title ?? '').toLowerCase().includes(q.toLowerCase()));
  const cats = new Map<string, typeof list>();
  for (const x of list) {
    const c = x.category ?? 'other';
    (cats.get(c) ?? cats.set(c, []).get(c)!).push(x);
  }
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="bpanel-tools">
        <input className="input small" placeholder="Filter variables" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <span className="faint">Changes apply live to the 3D view and the suspension page; save them with “Save part configuration as .pc”.</span>
      </div>
      <div className="list-scroll vars-grid">
        {[...cats].map(([cat, items]) => (
          <div key={cat} className="var-cat">
            <div className="group-label">{cat}</div>
            {items.map((x) => {
              const lo = Math.min(x.min, x.max), hi = Math.max(x.min, x.max);
              const step = (hi - lo) / 200 || 0.001;
              return (
                <div key={x.name} className="var-row" title={`${x.name}\n${x.description ?? ''}\ndefined in ${x.part}`}>
                  <button className="var-name ellipsis" onClick={() => x.row && revealRange(x.file, x.row.s, x.row.e)}>{x.title || x.name}</button>
                  <input type="range" min={lo} max={hi} step={step} value={x.val} onChange={(e) => ws.setVar(x.name, +e.target.value)} />
                  <span className="mono var-val">{+x.val.toPrecision(5)} {x.unit && x.unit !== '%' ? x.unit : ''}</span>
                  {x.val !== x.default && <button className="icon-btn small tiny" onClick={() => ws.setVar(x.name, undefined)} aria-label="Reset"><RotateCcw size={11} /></button>}
                </div>
              );
            })}
          </div>
        ))}
        {!list.length && <div className="empty-hint">This vehicle has no tuning variables.</div>}
      </div>
    </div>
  );
}

function Output() {
  const lines = useUi((x) => x.output);
  const ms = useWs((x) => x.assembleMs);
  return (
    <div className="list-scroll mono output">
      <div className="faint">last assembly: {ms.toFixed(1)} ms</div>
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

export { settings };

function ChecksBadge() {
  const res = useChecks((x) => x.results);
  if (!res) return null;
  const err = res.filter((f) => f.sev === 'error').length;
  const warn = res.filter((f) => f.sev === 'warning').length;
  return <>{err > 0 && <span className="badge err">{err}</span>} {warn > 0 && <span className="badge warn">{warn}</span>}</>;
}
