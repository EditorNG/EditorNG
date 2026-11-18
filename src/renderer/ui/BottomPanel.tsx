import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Lightbulb, X, Play, Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, type BottomTab } from '../state/ui';
import { useSettings, settings } from '../state/settings';
import { revealRange } from '../editor/CodeEditor';
import { CHECKS, massReport, type Finding } from '@core/analysis/debug';
import { useChecks, runAllChecks, setCheckEnabled, buildItems, setIgnored, useCheckCounts, type CheckItem } from '../state/checks';
import { openMenu } from './Menu';
import { GameLogTab } from './GameLink';
import { ReferencesTab } from './Tier2';
import { addToSel, emptySel, setSel, type Sel } from '../state/selection';
import { getViewport } from '../scene/ViewportPanel';
import * as ops from '../project/ops';
import { deleteNodes } from '@core/jbeam/edit';
import { pathAt, type ANode } from '@core/sjson';
import type { Vehicle } from '@core/jbeam/types';

const SEV_ICON = {
  error: <AlertCircle size={13} className="err-text" />,
  warning: <AlertTriangle size={13} className="warn-text" />,
  info: <Info size={13} className="info-text" />,
  hint: <Lightbulb size={13} className="faint" />,
};

export function BottomPanel() {
  const tab = useUi((x) => x.bottomTab);
  const counts = useCheckCounts();
  const tabBtn = (t: BottomTab, label: React.ReactNode) => (
    <button className={'btab' + (tab === t ? ' active' : '')} onClick={() => useUi.setState({ bottomTab: t })}>{label}</button>
  );
  return (
    <div className="bottom-panel">
      <div className="btabs">
        {tabBtn('checks', <>Checks {counts.error > 0 && <span className="badge err">{counts.error}</span>} {counts.warning > 0 && <span className="badge warn">{counts.warning}</span>}</>)}
        {tabBtn('gamelog', 'Game log')}
        {tabBtn('refs', 'References')}
        {tabBtn('mass', 'Weight')}
        {tabBtn('output', 'Output')}
        <div className="grow" />
        <button className="icon-btn small" onClick={() => useUi.setState({ bottom: false })} aria-label="Close panel"><X size={14} /></button>
      </div>
      <div className="bpanel-body">
        {tab === 'checks' && <Checks />}
        {tab === 'gamelog' && <GameLogTab />}
        {tab === 'refs' && <ReferencesTab />}
        {tab === 'mass' && <Mass />}
        {tab === 'output' && <Output />}
      </div>
    </div>
  );
}

/** last finding clicked and which of its rows is shown: clicking it again steps to the next row */
let lastFinding: { f: Finding; k: number } | null = null;

function selectFinding(v: Vehicle, f: Finding) {
  const s: Sel = emptySel();
  for (const i of f.nodes ?? []) s.nodes.add(v.nodes[i].name);
  // the beams / triangles themselves, so every row of a duplicate lights up in the code
  for (const i of f.beams ?? []) addToSel(v, s, 'beam', i);
  for (const i of f.tris ?? []) addToSel(v, s, 'tri', i);
  setSel(s);
  if (f.nodes?.length) getViewport()?.frameNodes(f.nodes);
  if (f.src) {
    revealRange(f.src.file, f.src.s, f.src.e);
    return;
  }
  const rows = f.beams?.length ? f.beams.map((i) => v.beams[i].row) : f.tris?.length ? f.tris.map((i) => v.tris[i].row) : f.nodes?.length ? [v.nodes[f.nodes[0]].row] : [];
  if (!rows.length) return;
  const k = lastFinding && lastFinding.f === f ? (lastFinding.k + 1) % rows.length : 0;
  lastFinding = { f, k };
  const row = rows[k];
  revealRange(row.src.file, row.src.node.s, row.src.node.e);
}

function openItem(v: Vehicle, it: CheckItem) {
  if (it.finding) selectFinding(v, it.finding);
  else if (it.issue?.file && it.issue.s !== undefined) revealRange(it.issue.file, it.issue.s, it.issue.e ?? it.issue.s, true);
}

/** rows a "remove the extras" fix deletes (all copies but the first) */
function extraRows(v: Vehicle, f: Finding) {
  const rows: Array<{ file: string; node: ANode }> = [];
  if (f.fix === 'deleteBeams') for (const i of (f.beams ?? []).slice(1)) rows.push({ file: v.beams[i].row.src.file, node: v.beams[i].row.src.node });
  if (f.fix === 'deleteTris') for (const i of (f.tris ?? []).slice(1)) rows.push({ file: v.tris[i].row.src.file, node: v.tris[i].row.src.node });
  return rows;
}

/** label of an item's own fix, or null */
function fixLabel(it: CheckItem): string | null {
  if (it.issue?.code === 'duplicate-slot' && it.issue.file) return 'Remove this repeated row';
  const f = it.finding;
  if (!f?.fix) return null;
  if (f.fix === 'snapRail') return 'Snap onto rail';
  if (f.fix === 'moveToTwin') return `Move to ${f.twin}`;
  return 'Remove the extras';
}

/** label of a group's "fix all" button, or null */
function fixAllLabel(group: string, items: CheckItem[]): string | null {
  if (!items.some((it) => fixLabel(it))) return null;
  if (group === 'problems') return 'Remove repeated slot rows';
  if (group === 'rails') return 'Snap onto rails';
  if (group === 'otherSidePart') return 'Move all to their part';
  return 'Remove extras';
}

/** Applies the fixes of several items, in one undo step where possible. */
function applyFixes(v: Vehicle, items: CheckItem[]): boolean {
  const fixable = items.filter((it) => fixLabel(it));
  if (!fixable.length) return false;
  const snaps = fixable.flatMap((it) => (it.finding?.fix === 'snapRail' ? it.finding.nodes ?? [] : []));
  if (snaps.length) return ops.snapToRails(snaps) > 0;
  const moves = fixable.filter((it) => it.finding?.fix === 'moveToTwin');
  if (moves.length) {
    let ok = false;
    const byTwin = new Map<string, CheckItem[]>();
    for (const it of moves) {
      const t = it.finding!.twin!;
      (byTwin.get(t) ?? byTwin.set(t, []).get(t)!).push(it);
    }
    for (const [twin, list] of byTwin) {
      const rows = list.flatMap((it) => [...(it.finding!.beams ?? []).map((i) => v.beams[i].row), ...(it.finding!.tris ?? []).map((i) => v.tris[i].row)]);
      ok = ops.moveRowsToPart(rows, twin, `Move rows to ${twin}`) || ok;
    }
    return ok;
  }
  const rows: Array<{ file: string; node: ANode }> = fixable.flatMap((it) => (it.finding ? extraRows(v, it.finding) : []));
  for (const it of fixable) {
    const i = it.issue;
    if (i?.code !== 'duplicate-slot' || !i.file) continue;
    const d = ws.doc(i.file);
    const hit = d?.jfile?.root ? pathAt(d.jfile.root, i.s!).map((p) => p.node).find((n) => n.s === i.s && n.e === i.e) : undefined;
    if (hit) rows.push({ file: d!.key, node: hit });
  }
  const map = new Map<string, ANode[]>();
  for (const r of rows) (map.get(r.file) ?? map.set(r.file, []).get(r.file)!).push(r.node);
  const edits = new Map([...map].map(([file, nodes]) => [file.toLowerCase(), deleteNodes(ws.doc(file)!.text, nodes)]));
  return edits.size > 0 && ops.applyRaw(items.length > 1 ? 'Fix findings' : 'Fix finding', edits);
}

/** lists longer than this are split per part, folded */
const SPLIT_AT = 12;

const PROBLEMS_DOC = 'Errors and warnings found while reading and assembling the vehicle: syntax, missing parts or nodes, repeated slots… Always up to date; the checks below run when you press Check.';

const RANK = { error: 0, warning: 1, info: 2, hint: 3 };

function Checks() {
  const v = useWs((x) => x.vehicle);
  const enabled = useChecks((x) => x.enabled);
  const res = useChecks((x) => x.results);
  const forV = useChecks((x) => x.forVehicle);
  const ignoredAll = useSettings((x) => x.s.ignoredFindings);
  const model = useWs((x) => x.model);
  const [active, setActive] = useState<string | null>(null);
  const [sev, setSev] = useState<'all' | 'error' | 'warning'>('all');
  const [loadInfo, setLoadInfo] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const stale = !!res && forV !== v;
  const ignored = useMemo(() => new Set(ignoredAll[model ?? '(loose files)'] ?? []), [ignoredAll, model]);
  // results of another vehicle (just switched) are not this one's: their indexes do not match
  const all = useMemo(() => buildItems(v, stale ? null : res), [v, res, stale]);
  const run = () => {
    if (v) runAllChecks();
  };
  const after = (ok: boolean) => {
    if (ok) setTimeout(run, 50);
  };
  // problems' own info / hints only on request: they are many and rarely matter
  const visible = (it: CheckItem) => (sev === 'all' || it.sev === sev) && (it.group !== 'problems' || it.sev === 'error' || it.sev === 'warning' || loadInfo);
  const byGroup = new Map<string, CheckItem[]>();
  let nIgnored = 0;
  for (const it of all) {
    if (!visible(it)) continue;
    if (ignored.has(it.key)) {
      nIgnored++;
      if (!showIgnored) continue;
    }
    (byGroup.get(it.group) ?? byGroup.set(it.group, []).get(it.group)!).push(it);
  }
  const groups: Array<{ id: string; title: string; doc: string }> = [{ id: 'problems', title: 'Problems', doc: PROBLEMS_DOC }, ...CHECKS];
  const shown = groups.filter((g) => (active ? g.id === active : byGroup.has(g.id)));
  const countOf = (id: string) => (byGroup.get(id) ?? []).filter((it) => !ignored.has(it.key)).length;

  const itemRow = (it: CheckItem, k: number, title: string, nested: boolean) => {
    const isIgnored = ignored.has(it.key);
    const f = it.finding;
    const fl = fixLabel(it);
    const d = it.issue?.file ? ws.doc(it.issue.file) : undefined;
    return (
      <button key={k} className={'problem' + (nested ? ' nested' : '') + (isIgnored ? ' ignored' : '')}
        title={f && (f.beams?.length ?? f.tris?.length ?? 0) > 1 && !f.src ? 'Click again to jump to the next row' : undefined}
        onClick={() => v && openItem(v, it)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!v) return;
          openMenu(e.clientX, e.clientY, [
            { label: it.finding ? 'Select in 3D' : 'Go to code', run: () => openItem(v, it) },
            fl && { label: fl, run: () => after(applyFixes(v, [it])) },
            'sep',
            isIgnored ? { label: 'Stop ignoring', run: () => setIgnored([it.key], false) } : { label: 'Ignore: this is intended', run: () => setIgnored([it.key], true) },
            it.group !== 'problems' && { label: `Stop running "${title}"`, run: () => setCheckEnabled(it.group, false) },
            { label: 'Copy message', run: () => navigator.clipboard.writeText(it.msg) },
          ]);
        }}>
        {SEV_ICON[it.sev]}
        <span className={'ellipsis grow' + (it.finding ? ' mono' : '')}>{it.msg}</span>
        {isIgnored && <span className="faint small-text">ignored</span>}
        {!nested && (d || it.part) && <span className="faint ellipsis small-text" style={{ maxWidth: 260 }}>{d ? d.name : ''}{d && it.part ? ' · ' : ''}{it.part}</span>}
      </button>
    );
  };

  return (
    <div className="checks">
      <div className="checks-left">
        <button className="btn primary small" onClick={run} disabled={!v}><Play size={12} /> Run checks</button>
        <div className={'check-row' + (active === 'problems' ? ' active' : '')} title={PROBLEMS_DOC}>
          <span className="switch-spacer" />
          <button className="check-name" onClick={() => setActive(active === 'problems' ? null : 'problems')}>Problems</button>
          <span className={'badge' + (countOf('problems') ? ' warn' : '')}>{countOf('problems')}</span>
        </div>
        <div className="ctx-sep" />
        {CHECKS.map((c) => (
          <div key={c.id} className={'check-row' + (active === c.id ? ' active' : '')} title={c.doc}>
            <button className={'switch' + (enabled.has(c.id) ? ' on' : '')} onClick={() => setCheckEnabled(c.id, !enabled.has(c.id))} aria-label={c.title} />
            <button className="check-name" onClick={() => setActive(active === c.id ? null : c.id)}>{c.title}</button>
            {res && <span className={'badge' + (countOf(c.id) ? ' warn' : '')}>{countOf(c.id)}</span>}
          </div>
        ))}
      </div>
      <div className="col grow" style={{ minHeight: 0 }}>
        <div className="bpanel-tools">
          <div className="segmented small">
            {(['all', 'error', 'warning'] as const).map((x) => (
              <button key={x} className={'seg' + (sev === x ? ' active' : '')} onClick={() => setSev(x)}>{x === 'all' ? 'All' : x === 'error' ? 'Errors' : 'Warnings'}</button>
            ))}
          </div>
          <label className="row dim" data-tip="Notes from reading the files: nodes redefined on purpose, extra commas…"><button className={'switch' + (loadInfo ? ' on' : '')} onClick={() => setLoadInfo(!loadInfo)} aria-label="Show loading notes" /> Loading notes</label>
          {(nIgnored > 0 || showIgnored) && <label className="row dim"><button className={'switch' + (showIgnored ? ' on' : '')} onClick={() => setShowIgnored(!showIgnored)} aria-label="Show ignored" /> Show ignored ({nIgnored})</label>}
          <div className="grow" />
          {!res && <span className="faint">Structural checks not run yet</span>}
          {stale && <span className="faint">The vehicle changed since the last run</span>}
        </div>
        <div className="list-scroll">
          {!shown.length && <div className="empty-hint">{res ? 'Nothing to report. 🎉' : 'No problems while loading. Press Run checks for the structural checks.'}</div>}
          {shown.map((g) => {
            const list = (byGroup.get(g.id) ?? []).sort((a, b) => RANK[a.sev] - RANK[b.sev]);
            if (!list.length) return null;
            const live = list.filter((it) => !ignored.has(it.key));
            const fa = fixAllLabel(g.id, live);
            const parts = new Map<string, CheckItem[]>();
            for (const it of list) (parts.get(it.part) ?? parts.set(it.part, []).get(it.part)!).push(it);
            const split = list.length > SPLIT_AT && parts.size > 1;
            return (
              <div key={g.id}>
                <div className="group-label" title={g.doc}>
                  {g.title} <span className="badge">{countOf(g.id)}</span>
                  {fa && v && <button className="btn small ghost" onClick={() => after(applyFixes(v, live))}><Wrench size={12} /> {fa}</button>}
                </div>
                {!split && list.slice(0, 500).map((it, k) => itemRow(it, k, g.title, false))}
                {split && [...parts].sort((a, b) => b[1].length - a[1].length).map(([part, items]) => {
                  const key = g.id + '|' + part;
                  const isOpen = open.has(key);
                  const toggle = () => {
                    const n = new Set(open);
                    if (isOpen) n.delete(key);
                    else n.add(key);
                    setOpen(n);
                  };
                  const pLive = items.filter((it) => !ignored.has(it.key));
                  const worst = items.reduce<CheckItem['sev']>((w, it) => (RANK[it.sev] < RANK[w] ? it.sev : w), 'hint');
                  return (
                    <div key={key}>
                      <button className="problem part-head" onClick={toggle} onContextMenu={(e) => {
                        e.preventDefault();
                        openMenu(e.clientX, e.clientY, [
                          { label: isOpen ? 'Fold' : 'Unfold', run: toggle },
                          pLive.length > 0 && { label: `Ignore all ${pLive.length} in ${part || 'this group'}`, run: () => setIgnored(pLive.map((it) => it.key), true) },
                          pLive.length < items.length && { label: 'Stop ignoring them', run: () => setIgnored(items.map((it) => it.key), false) },
                        ]);
                      }}>
                        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {SEV_ICON[worst]}
                        <span className="mono ellipsis grow">{part || '(no part)'}</span>
                        <span className="badge">{pLive.length}</span>
                      </button>
                      {isOpen && items.slice(0, 500).map((it, k) => itemRow(it, k, g.title, true))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
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
