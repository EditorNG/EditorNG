/** Structural check results, shared by the title-bar Check button and the Checks tab. */
import { create } from 'zustand';
import { CHECKS, runChecks, type Finding } from '@core/analysis/debug';
import { settings } from './settings';
import { ws } from '../project/workspace';

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
  const res = runChecks(v, { shortBeam: s.debugShortBeam, closeNodes: s.debugCloseNodes, minBeams: s.debugMinBeamsPerNode, mirrorTolerance: s.mirrorTolerance, suffixL: s.mirrorSuffixLeft, suffixR: s.mirrorSuffixRight, editable: (f) => {
    const d = ws.doc(f);
    return !!d?.writable && !d.isCommon;
  } }, useChecks.getState().enabled);
  useChecks.setState({ results: res, forVehicle: v });
  return res;
}

export function setCheckEnabled(id: string, on: boolean) {
  const n = new Set(useChecks.getState().enabled);
  if (on) n.add(id);
  else n.delete(id);
  useChecks.setState({ enabled: n });
}
