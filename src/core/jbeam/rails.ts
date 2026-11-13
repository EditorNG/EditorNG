/**
 * Rails and slidenodes: lookup and polyline geometry (closest point, arc-length parametrisation).
 */
import type { AObj, AStr } from '../sjson';
import type { ActivePart, Row, Vehicle } from './types';

export interface VRail {
  name: string;
  nodes: number[];
  looped: boolean;
  capped: boolean;
  part: ActivePart;
  file: string;
  /** "name" key and its value in the source */
  key: AStr;
  value: AObj;
  /** names in "links:" that are not nodes */
  missing: string[];
}

export interface VSlide {
  node: number;
  rail: string;
  row: Row;
}

type P3 = [number, number, number];

/** Rails from every active part ("rails" and "rails2", later parts win like the game's merge). */
export function collectRails(v: Vehicle): Map<string, VRail> {
  const out = new Map<string, VRail>();
  for (const p of v.parts) {
    for (const sec of ['rails', 'rails2']) {
      const node = p.def.sections.get(sec);
      if (!node || node.k !== 'obj') continue;
      node.keys.forEach((k, i) => {
        const val = node.vals[i];
        if (val.k !== 'obj') return;
        let links: string[] = [];
        let looped = false, capped = true;
        val.keys.forEach((kk, j) => {
          const vv = val.vals[j];
          if (kk.v === 'links:' && vv.k === 'arr') links = vv.items.filter((x) => x.k === 'str').map((x) => (x as AStr).v);
          if (kk.v === 'looped' && vv.k === 'bool') looped = vv.v;
          if (kk.v === 'capped' && vv.k === 'bool') capped = vv.v;
        });
        const nodes: number[] = [];
        const missing: string[] = [];
        for (const l of links) {
          const ix = v.nodeIndex.get(l);
          if (ix === undefined) missing.push(l);
          else nodes.push(ix);
        }
        out.set(k.v, { name: k.v, nodes, looped, capped, part: p, file: p.def.file, key: k, value: val, missing });
      });
    }
  }
  return out;
}

export function collectSlides(v: Vehicle): VSlide[] {
  const out: VSlide[] = [];
  for (const row of v.tables.get('slidenodes') ?? []) {
    const id = row.v['id:'];
    const ix = typeof id === 'string' ? v.nodeIndex.get(id) : undefined;
    if (ix === undefined || typeof row.v.railName !== 'string') continue;
    out.push({ node: ix, rail: row.v.railName, row });
  }
  return out;
}

export function railPoints(rail: VRail, pos: ArrayLike<number>): P3[] {
  return rail.nodes.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as P3);
}

function segs(pts: P3[], looped: boolean): Array<[P3, P3]> {
  const out: Array<[P3, P3]> = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
  if (looped && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

const dist = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function railLength(pts: P3[], looped: boolean): number {
  return segs(pts, looped).reduce((s, [a, b]) => s + dist(a, b), 0);
}

/** Closest point on the rail: arc length s, the point, distance, segment index and tangent. */
export function closestOnRail(pts: P3[], looped: boolean, p: P3): { s: number; point: P3; dist: number; seg: number; tangent: P3 } | null {
  const ss = segs(pts, looped);
  if (!ss.length) return null;
  let best: { s: number; point: P3; dist: number; seg: number; tangent: P3 } | null = null;
  let acc = 0;
  ss.forEach(([a, b], i) => {
    const d: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const L = Math.sqrt(l2);
    let t = l2 > 0 ? ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q: P3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
    const dd = dist(p, q);
    if (!best || dd < best.dist - 1e-12) best = { s: acc + t * L, point: q, dist: dd, seg: i, tangent: L > 0 ? [d[0] / L, d[1] / L, d[2] / L] : [1, 0, 0] };
    acc += L;
  });
  return best;
}

/** Point at arc length s (clamped to the ends, or wrapped on looped rails). */
export function pointAtS(pts: P3[], looped: boolean, s: number): P3 {
  const ss = segs(pts, looped);
  if (!ss.length) return pts[0] ?? [0, 0, 0];
  const total = ss.reduce((a, [p, q]) => a + dist(p, q), 0);
  if (looped && total > 0) s = ((s % total) + total) % total;
  else s = Math.max(0, Math.min(total, s));
  let acc = 0;
  for (const [a, b] of ss) {
    const L = dist(a, b);
    if (s <= acc + L || b === ss[ss.length - 1][1]) {
      const t = L > 0 ? Math.min(1, Math.max(0, (s - acc) / L)) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    acc += L;
  }
  return ss[ss.length - 1][1];
}

/** Slidenodes that are not on their rail (beyond max(tolerance, minDist)). */
export function offRailSlides(v: Vehicle, minDist = 0.002): Array<{ slide: VSlide; dist: number; rail?: VRail }> {
  const rails = collectRails(v);
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  const out: Array<{ slide: VSlide; dist: number; rail?: VRail }> = [];
  for (const sl of collectSlides(v)) {
    const r = rails.get(sl.rail);
    if (!r) {
      out.push({ slide: sl, dist: Infinity });
      continue;
    }
    const c = closestOnRail(railPoints(r, pos), r.looped, [pos[sl.node * 3], pos[sl.node * 3 + 1], pos[sl.node * 3 + 2]]);
    const tol = typeof sl.row.v.tolerance === 'number' ? sl.row.v.tolerance : 0;
    if (c && c.dist > Math.max(tol, minDist)) out.push({ slide: sl, dist: c.dist, rail: r });
  }
  return out;
}
