/**
 * Checks: the assembly problems (always there) and the structural check results (on demand),
 * shown together in the Checks tab and counted by the title-bar Check button and the status bar.
 */
import { create } from 'zustand';
import { useMemo } from 'react';
import { CHECKS, runChecks, type Finding } from '@core/analysis/debug';
import type { Issue, Vehicle } from '@core/jbeam/types';
import { settings, useSettings } from './settings';
import { ws, useWs } from '../project/workspace';

interface ChecksState {
  enabled: Set<string>;
  results: Finding[] | null;
  /** vehicle object the results belong to (stale when it changes) */
  forVehicle: unknown;
}

export const useChecks = create<ChecksState>(() => ({
  enabled: new Set(CHECKS.map((c) => c.id).filter((id) => id !== 'weakNodes' && id !== 'heavyNodes')),
  results: null,
  forVehicle: null,
}));

export function runAllChecks(): Finding[] {
  const v = ws.vehicle;
  if (!v) return [];
  const s = settings();
  const texts = [...ws.docs.values()].filter((d) => /\.jbeam$/i.test(d.key) && d.text).map((d) => ({ file: d.vpath, text: d.text }));
  const res = runChecks(v, {
    shortBeam: s.debugShortBeam, closeNodes: s.debugCloseNodes, minBeams: s.debugMinBeamsPerNode, mirrorTolerance: s.mirrorTolerance, suffixL: s.mirrorSuffixLeft, suffixR: s.mirrorSuffixRight,
    editable: (f) => {
      const d = ws.doc(f);
      return !!d?.writable && !d.isCommon;
    },
    texts,
  }, useChecks.getState().enabled);
  useChecks.setState({ results: res, forVehicle: v });
  return res;
}

export function setCheckEnabled(id: string, on: boolean) {
  const n = new Set(useChecks.getState().enabled);
  if (on) n.add(id);
  else n.delete(id);
  useChecks.setState({ enabled: n });
}

// ---------------------------------------------------------------------------------------------
// one list: problems + findings
// ---------------------------------------------------------------------------------------------

export type ItemSev = 'error' | 'warning' | 'info' | 'hint';

export interface CheckItem {
  /** 'problems' or a check id */
  group: string;
  sev: ItemSev;
  msg: string;
  /** stable identity for "ignore" */
  key: string;
  /** part it is about (groups long lists) */
  part: string;
  issue?: Issue;
  finding?: Finding;
}

function findingPart(v: Vehicle, f: Finding): string {
  if (f.part) return f.part;
  if (f.beams?.length) return v.beams[f.beams[0]].row.part.def.name;
  if (f.tris?.length) return v.tris[f.tris[0]].row.part.def.name;
  if (f.nodes?.length) return v.nodes[f.nodes[0]].row.part.def.name;
  if (f.src) return v.parts.find((p) => p.def.file.toLowerCase() === f.src!.file.toLowerCase())?.def.name ?? '';
  return '';
}

export function buildItems(v: Vehicle | null, results: Finding[] | null): CheckItem[] {
  if (!v) return [];
  const out: CheckItem[] = [];
  for (const i of v.issues) out.push({ group: 'problems', sev: i.sev, msg: i.msg, key: `problems|${i.code}|${i.msg}`, part: i.part ?? '', issue: i });
  for (const f of results ?? []) out.push({ group: f.check, sev: f.sev, msg: f.msg, key: `${f.check}|${f.msg}`, part: findingPart(v, f), finding: f });
  return out;
}

/** model the ignore list is kept for */
export function ignoreScope(): string {
  return ws.model ?? '(loose files)';
}

export function ignoredKeys(): Set<string> {
  return new Set(settings().ignoredFindings[ignoreScope()] ?? []);
}

export function setIgnored(keys: string[], ignored: boolean) {
  const st = useSettings.getState();
  const all = { ...st.s.ignoredFindings };
  const cur = new Set(all[ignoreScope()] ?? []);
  for (const k of keys) {
    if (ignored) cur.add(k);
    else cur.delete(k);
  }
  if (cur.size) all[ignoreScope()] = [...cur];
  else delete all[ignoreScope()];
  st.set({ ignoredFindings: all });
}

/** Errors / warnings not ignored: problems always, findings once checks ran on this vehicle. */
export function useCheckCounts(): { error: number; warning: number; ran: boolean; stale: boolean } {
  const v = useWs((x) => x.vehicle);
  const res = useChecks((x) => x.results);
  const forV = useChecks((x) => x.forVehicle);
  const ignored = useSettings((x) => x.s.ignoredFindings);
  const model = useWs((x) => x.model);
  return useMemo(() => {
    const stale = !!res && forV !== v;
    const ig = new Set(ignored[model ?? '(loose files)'] ?? []);
    const c = { error: 0, warning: 0, ran: !!res, stale };
    for (const it of buildItems(v, stale ? null : res)) {
      if (ig.has(it.key)) continue;
      if (it.sev === 'error') c.error++;
      else if (it.sev === 'warning') c.warning++;
    }
    return c;
  }, [v, res, forV, ignored, model]);
}
