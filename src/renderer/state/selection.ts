import { create } from 'zustand';
import type { Vehicle } from '@core/jbeam/types';

/**
 * Selection is stored by stable keys (node names, node-name pairs) so it survives
 * re-assembly after every edit.
 */
export interface Sel {
  nodes: Set<string>;
  beams: Set<string>;
  tris: Set<string>;
  flex: Set<string>;
  props: Set<string>;
  triggers: Set<string>;
}

export type PickMode = 'nodes' | 'beams' | 'tris' | 'all';

export interface Hover {
  kind: 'node' | 'beam' | 'tri' | 'flex' | 'prop' | 'trigger' | 'wheel';
  idx: number;
}

export type ViewScope = { mode: 'vehicle' } | { mode: 'file'; file: string } | { mode: 'part'; part: string; file: string };

/** Part names visible for a scope (null = everything). */
export function scopeParts(v: Vehicle | null, scope: ViewScope): Set<string> | null {
  if (!v || scope.mode === 'vehicle') return null;
  if (scope.mode === 'part') return new Set([scope.part]);
  const set = new Set<string>();
  for (const p of v.parts) if (p.def.file === scope.file) set.add(p.def.name);
  return set;
}

export interface SelState {
  sel: Sel;
  hover: Hover | null;
  /** highlighted from the code editor cursor */
  highlight: Sel;
  mode: PickMode;
  /** what the 3D view shows: one part, one file, or the whole vehicle */
  scope: ViewScope;
  /** last element clicked (for "active" display) */
  active: Hover | null;
}

export const emptySel = (): Sel => ({ nodes: new Set(), beams: new Set(), tris: new Set(), flex: new Set(), props: new Set(), triggers: new Set() });

export const useSel = create<SelState>(() => ({
  sel: emptySel(),
  hover: null,
  highlight: emptySel(),
  mode: 'all',
  scope: { mode: 'vehicle' },
  active: null,
}));

export function beamKey(a: string, b: string): string {
  return a < b ? a + '\u0001' + b : b + '\u0001' + a;
}
export function triKey(a: string, b: string, c: string): string {
  return [a, b, c].sort().join('\u0001');
}
export function rowKey(file: string, offset: number): string {
  return file + '@' + offset;
}

export function selCount(s: Sel): number {
  return s.nodes.size + s.beams.size + s.tris.size + s.flex.size + s.props.size + s.triggers.size;
}

export function setSel(sel: Sel, active: Hover | null = null) {
  useSel.setState({ sel, active });
}

export function clearSel() {
  setSel(emptySel());
}

/** Index sets for the current vehicle. */
export interface SelIdx {
  nodes: Set<number>;
  beams: Set<number>;
  tris: Set<number>;
  flex: Set<number>;
  props: Set<number>;
  triggers: Set<number>;
}

export function resolveSel(v: Vehicle | null, s: Sel): SelIdx {
  const out: SelIdx = { nodes: new Set(), beams: new Set(), tris: new Set(), flex: new Set(), props: new Set(), triggers: new Set() };
  if (!v) return out;
  for (const n of s.nodes) {
    const i = v.nodeIndex.get(n);
    if (i !== undefined) out.nodes.add(i);
  }
  if (s.beams.size) {
    v.beams.forEach((b, i) => {
      if (s.beams.has(beamKey(v.nodes[b.a].name, v.nodes[b.b].name))) out.beams.add(i);
    });
  }
  if (s.tris.size) {
    v.tris.forEach((t, i) => {
      if (s.tris.has(triKey(v.nodes[t.a].name, v.nodes[t.b].name, v.nodes[t.c].name))) out.tris.add(i);
    });
  }
  if (s.flex.size) v.flexbodies.forEach((f, i) => s.flex.has(rowKey(f.row.src.file, f.row.src.node.s)) && out.flex.add(i));
  if (s.props.size) v.props.forEach((p, i) => s.props.has(rowKey(p.row.src.file, p.row.src.node.s)) && out.props.add(i));
  if (s.triggers.size) (v.tables.get('triggers2') ?? []).forEach((r, i) => s.triggers.has(rowKey(r.src.file, r.src.node.s)) && out.triggers.add(i));
  return out;
}

/** Adds element keys to a selection. */
export function addToSel(v: Vehicle, s: Sel, kind: Hover['kind'], idx: number, toggle = false) {
  const flip = (set: Set<string>, k: string) => {
    if (toggle && set.has(k)) set.delete(k);
    else set.add(k);
  };
  if (kind === 'node') flip(s.nodes, v.nodes[idx].name);
  else if (kind === 'beam') {
    const b = v.beams[idx];
    flip(s.beams, beamKey(v.nodes[b.a].name, v.nodes[b.b].name));
  } else if (kind === 'tri') {
    const t = v.tris[idx];
    flip(s.tris, triKey(v.nodes[t.a].name, v.nodes[t.b].name, v.nodes[t.c].name));
  } else if (kind === 'flex') {
    const f = v.flexbodies[idx];
    flip(s.flex, rowKey(f.row.src.file, f.row.src.node.s));
  } else if (kind === 'prop') {
    const p = v.props[idx];
    flip(s.props, rowKey(p.row.src.file, p.row.src.node.s));
  } else if (kind === 'trigger') {
    const r = (v.tables.get('triggers2') ?? [])[idx];
    if (r) flip(s.triggers, rowKey(r.src.file, r.src.node.s));
  } else if (kind === 'wheel') {
    const w = v.wheels[idx];
    flip(s.nodes, v.nodes[w.n1].name);
    flip(s.nodes, v.nodes[w.n2].name);
  }
}

export function cloneSel(s: Sel): Sel {
  return {
    nodes: new Set(s.nodes),
    beams: new Set(s.beams),
    tris: new Set(s.tris),
    flex: new Set(s.flex),
    props: new Set(s.props),
    triggers: new Set(s.triggers),
  };
}

/** Nodes touched by the selection (selected nodes + endpoints of selected beams/tris). */
export function selNodeIdx(v: Vehicle, si: SelIdx): Set<number> {
  const out = new Set(si.nodes);
  for (const i of si.beams) {
    out.add(v.beams[i].a);
    out.add(v.beams[i].b);
  }
  for (const i of si.tris) {
    out.add(v.tris[i].a);
    out.add(v.tris[i].b);
    out.add(v.tris[i].c);
  }
  return out;
}
