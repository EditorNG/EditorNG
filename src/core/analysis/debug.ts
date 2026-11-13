/**
 * Structural checks on an assembled vehicle. Pure functions, no UI.
 */
import type { Vehicle } from '../jbeam/types';
import { collectRails, offRailSlides } from '../jbeam/rails';
import { modifierLeaks, RISKY_KEYS } from './modifiers';

export type CheckSev = 'error' | 'warning' | 'info';

export interface Finding {
  check: string;
  sev: CheckSev;
  msg: string;
  nodes?: number[];
  beams?: number[];
  tris?: number[];
  /** where to jump in code (overrides the first element's row) */
  src?: { file: string; s: number; e: number };
  /** optional automatic fix id */
  fix?: 'deleteBeams' | 'deleteTris' | 'snapRail';
}

export interface CheckOptions {
  shortBeam: number;
  closeNodes: number;
  minBeams: number;
  mirrorTolerance: number;
  suffixL: string;
  suffixR: string;
  /** files the user can edit; leak findings are limited to leaks touching them */
  editable?: (file: string) => boolean;
}

export const CHECKS: Array<{ id: string; title: string; doc: string }> = [
  { id: 'duplicateBeams', title: 'Duplicate beams', doc: 'Two or more beams between the same pair of nodes. Usually a copy/paste leftover; doubles the stiffness.' },
  { id: 'zeroBeams', title: 'Zero / very short beams', doc: 'Beams shorter than the threshold. They are unstable and often the result of duplicated nodes.' },
  { id: 'orphanNodes', title: 'Nodes without beams', doc: 'Nodes that no beam references. They fall through the world or float.' },
  { id: 'weakNodes', title: 'Under-connected nodes', doc: 'Nodes with fewer beams than the threshold. A node needs at least 3 non-coplanar beams to be held in place.' },
  { id: 'closeNodes', title: 'Coincident nodes', doc: 'Different nodes at (almost) the same position.' },
  { id: 'duplicateTris', title: 'Duplicate triangles', doc: 'Triangles using the same three nodes.' },
  { id: 'degenerateTris', title: 'Degenerate triangles', doc: 'Triangles with (almost) no area.' },
  { id: 'asymmetry', title: 'Left/right asymmetry', doc: 'Nodes named with a side suffix whose mirror twin is not at the mirrored position.' },
  { id: 'wrongSide', title: 'Side suffix on wrong side', doc: 'Left-suffixed nodes at -X or right-suffixed nodes at +X (+X is the car\'s left).' },
  { id: 'flexGroups', title: 'Flexbody groups without nodes', doc: 'Flexbodies referencing node groups that no node belongs to; the mesh will not be shown.' },
  { id: 'heavyNodes', title: 'Extreme node weights', doc: 'Nodes weighing more than 50 kg or less than 0.05 kg.' },
  { id: 'modLeaks', title: 'Leaking modifiers', doc: 'A {"key": value} modifier row stays in effect for the rest of its section, and the game carries it into the same section of every part assembled after it. Values that are not reset at the end of a part change rows of other parts. Reset them with {"key": ""} (or the default) at the end of the section.' },
  { id: 'rails', title: 'Rails & slidenodes', doc: 'Rails with unknown nodes, slidenodes on rails that do not exist, and slidenodes that are not on their rail (they jump onto it when the vehicle spawns). Fix with Snap onto rail (Shift+R).' },
];

function beamLen(v: Vehicle, i: number): number {
  const b = v.beams[i];
  const A = v.nodes[b.a], B = v.nodes[b.b];
  return Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
}

export function runChecks(v: Vehicle, o: CheckOptions, enabled?: Set<string>): Finding[] {
  const out: Finding[] = [];
  const on = (id: string) => !enabled || enabled.has(id);

  if (on('duplicateBeams')) {
    const map = new Map<string, number[]>();
    v.beams.forEach((b, i) => {
      if (b.section !== 'beams') return;
      const k = b.a < b.b ? b.a + ':' + b.b : b.b + ':' + b.a;
      let l = map.get(k);
      if (!l) map.set(k, (l = []));
      l.push(i);
    });
    for (const l of map.values()) {
      if (l.length < 2) continue;
      const b = v.beams[l[0]];
      const parts = [...new Set(l.map((i) => v.beams[i].row.part.def.name))];
      out.push({
        check: 'duplicateBeams', sev: parts.length > 1 ? 'info' : 'warning',
        msg: `${v.nodes[b.a].name} — ${v.nodes[b.b].name} ×${l.length}${parts.length > 1 ? ` (parts: ${parts.join(', ')})` : ` in ${parts[0]}`}`,
        beams: l, nodes: [b.a, b.b], fix: parts.length === 1 ? 'deleteBeams' : undefined,
      });
    }
  }
  if (on('zeroBeams')) {
    v.beams.forEach((b, i) => {
      const l = beamLen(v, i);
      if (l < o.shortBeam) out.push({ check: 'zeroBeams', sev: l < 1e-4 ? 'error' : 'warning', msg: `${v.nodes[b.a].name} — ${v.nodes[b.b].name}: ${(l * 1000).toFixed(2)} mm`, beams: [i], nodes: [b.a, b.b] });
    });
  }
  const count = new Int32Array(v.nodes.length);
  for (const b of v.beams) {
    count[b.a]++;
    count[b.b]++;
  }
  const wheelNodes = new Set<number>();
  for (const w of v.wheels) {
    wheelNodes.add(w.n1);
    wheelNodes.add(w.n2);
  }
  if (on('orphanNodes')) {
    v.nodes.forEach((n, i) => {
      if (count[i] === 0 && !n.virtual) out.push({ check: 'orphanNodes', sev: 'warning', msg: `${n.name} (${n.row.part.def.name})`, nodes: [i] });
    });
  }
  if (on('weakNodes')) {
    v.nodes.forEach((n, i) => {
      if (count[i] > 0 && count[i] < o.minBeams && !wheelNodes.has(i)) out.push({ check: 'weakNodes', sev: 'info', msg: `${n.name}: ${count[i]} beam${count[i] > 1 ? 's' : ''} (${n.row.part.def.name})`, nodes: [i] });
    });
  }
  if (on('closeNodes')) {
    const cell = Math.max(o.closeNodes, 1e-4);
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    v.nodes.forEach((n, i) => {
      const k = key(n.x, n.y, n.z);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    });
    const seen = new Set<string>();
    v.nodes.forEach((n, i) => {
      const cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell), cz = Math.floor(n.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (j <= i) continue;
          const m = v.nodes[j];
          const d = Math.hypot(n.x - m.x, n.y - m.y, n.z - m.z);
          if (d > o.closeNodes) continue;
          const k = i + ':' + j;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ check: 'closeNodes', sev: d < 1e-5 ? 'warning' : 'info', msg: `${n.name} & ${m.name}: ${(d * 1000).toFixed(2)} mm`, nodes: [i, j] });
        }
      }
    });
  }
  if (on('duplicateTris') || on('degenerateTris')) {
    const map = new Map<string, number[]>();
    v.tris.forEach((t, i) => {
      const k = [t.a, t.b, t.c].sort((a, b) => a - b).join(':');
      let l = map.get(k);
      if (!l) map.set(k, (l = []));
      l.push(i);
      if (on('degenerateTris')) {
        const A = v.nodes[t.a], B = v.nodes[t.b], C = v.nodes[t.c];
        const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z, wx = C.x - A.x, wy = C.y - A.y, wz = C.z - A.z;
        const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
        if (area < 1e-6) out.push({ check: 'degenerateTris', sev: 'warning', msg: `${A.name}, ${B.name}, ${C.name}: ${(area * 1e6).toFixed(2)} mm²`, tris: [i], nodes: [t.a, t.b, t.c] });
      }
    });
    if (on('duplicateTris')) {
      for (const l of map.values()) if (l.length > 1) {
        const t = v.tris[l[0]];
        out.push({ check: 'duplicateTris', sev: 'warning', msg: `${v.nodes[t.a].name}, ${v.nodes[t.b].name}, ${v.nodes[t.c].name} ×${l.length}`, tris: l, nodes: [t.a, t.b, t.c], fix: 'deleteTris' });
      }
    }
  }
  if (on('asymmetry') || on('wrongSide')) {
    const L = o.suffixL, R = o.suffixR;
    const re = new RegExp(`^(.*?)(${L}+|${R}+)$`);
    v.nodes.forEach((n, i) => {
      const m = re.exec(n.name);
      if (!m || !m[1]) return;
      const isL = m[2].startsWith(L);
      if (on('wrongSide') && ((isL && n.x < -o.mirrorTolerance) || (!isL && n.x > o.mirrorTolerance))) {
        out.push({ check: 'wrongSide', sev: 'info', msg: `${n.name} is at x=${n.x.toFixed(3)}`, nodes: [i] });
      }
      if (!on('asymmetry') || !isL) return;
      const twinName = m[1] + R.repeat(m[2].length / L.length);
      const j = v.nodeIndex.get(twinName);
      if (j === undefined) return;
      const t = v.nodes[j];
      const d = Math.hypot(n.x + t.x, n.y - t.y, n.z - t.z);
      if (d > o.mirrorTolerance) out.push({ check: 'asymmetry', sev: 'info', msg: `${n.name} / ${t.name}: off by ${(d * 1000).toFixed(1)} mm`, nodes: [i, j] });
    });
  }
  if (on('flexGroups')) {
    const groups = new Set<string>();
    for (const n of v.nodes) for (const g of n.groups) groups.add(g);
    v.flexbodies.forEach((f) => {
      const missing = f.groups.filter((g) => !groups.has(g));
      if (missing.length && missing.length === f.groups.length) out.push({ check: 'flexGroups', sev: 'warning', msg: `${f.mesh}: ${missing.join(', ')}` });
    });
  }
  if (on('heavyNodes')) {
    v.nodes.forEach((n, i) => {
      const w = nodeWeight(v, i);
      if (w > 50 || w < 0.05) out.push({ check: 'heavyNodes', sev: 'info', msg: `${n.name}: ${w.toFixed(2)} kg`, nodes: [i] });
    });
  }
  if (on('modLeaks')) {
    for (const l of modifierLeaks(v)) {
      const rows = [...l.into.values()].flat();
      if (o.editable && !o.editable(l.origin.file) && !rows.some((r) => o.editable!(r.src.file))) continue;
      const nodes = new Set<number>();
      for (const r of rows) {
        if (l.section === 'nodes') {
          const i = v.nodeIndex.get(String(r.v.id));
          if (i !== undefined) nodes.add(i);
        } else for (const k of ['id1:', 'id2:', 'id3:']) {
          const i = typeof r.v[k] === 'string' ? v.nodeIndex.get(r.v[k]) : undefined;
          if (i !== undefined) nodes.add(i);
        }
      }
      const val = typeof l.value === 'number' ? (Number.isFinite(l.value) ? String(l.value) : 'FLT_MAX') : JSON.stringify(l.value);
      out.push({
        check: 'modLeaks', sev: RISKY_KEYS.has(l.key) ? 'warning' : 'info',
        msg: `${l.section}: ${l.key} = ${val} from ${l.origin.part} leaks into ${rows.length} row${rows.length > 1 ? 's' : ''} of ${[...l.into.keys()].join(', ')}`,
        nodes: [...nodes], src: { file: l.origin.file, s: l.origin.s, e: l.origin.e },
      });
    }
  }
  if (on('rails')) {
    for (const r of collectRails(v).values()) {
      if (r.missing.length) out.push({ check: 'rails', sev: 'error', msg: `rail ${r.name}: unknown node(s) ${r.missing.join(', ')} (${r.part.def.name})`, nodes: r.nodes });
      else if (r.nodes.length < 2) out.push({ check: 'rails', sev: 'error', msg: `rail ${r.name}: needs at least 2 nodes (${r.part.def.name})`, nodes: r.nodes });
    }
    for (const o of offRailSlides(v)) {
      const n = v.nodes[o.slide.node];
      if (!o.rail) out.push({ check: 'rails', sev: 'error', msg: `${n.name}: slidenode on unknown rail "${o.slide.rail}"`, nodes: [o.slide.node] });
      else out.push({ check: 'rails', sev: o.dist > 0.05 ? 'warning' : 'info', msg: `${n.name}: ${(o.dist * 1000).toFixed(1)} mm off rail ${o.rail.name} (snaps on spawn)`, nodes: [o.slide.node], fix: 'snapRail' });
    }
  }
  return out;
}

export function nodeWeight(v: Vehicle, i: number): number {
  const w = Number(v.nodes[i].row.v.nodeWeight);
  return Number.isFinite(w) ? w : 25;
}

export interface MassReport {
  total: number;
  cog: [number, number, number];
  byPart: Array<{ part: string; mass: number; nodes: number }>;
  front: number;
  rear: number;
  left: number;
  right: number;
  /** split between axles when wheels exist */
  axles: Array<{ y: number; load: number }>;
}

export function massReport(v: Vehicle): MassReport {
  let total = 0, cx = 0, cy = 0, cz = 0;
  const parts = new Map<string, { mass: number; nodes: number }>();
  let front = 0, rear = 0, left = 0, right = 0;
  v.nodes.forEach((n, i) => {
    const w = nodeWeight(v, i);
    total += w;
    cx += n.x * w;
    cy += n.y * w;
    cz += n.z * w;
    const p = n.row.part.def.name;
    const e = parts.get(p) ?? { mass: 0, nodes: 0 };
    e.mass += w;
    e.nodes++;
    parts.set(p, e);
    if (n.x >= 0) left += w;
    else right += w;
  });
  const cog: [number, number, number] = total ? [cx / total, cy / total, cz / total] : [0, 0, 0];
  // axle split by moment balance over the two extreme wheel axle positions
  const ys = [...new Set(v.wheels.map((w) => Math.round(((v.nodes[w.n1].y + v.nodes[w.n2].y) / 2) * 100) / 100))].sort((a, b) => a - b);
  const axles: MassReport['axles'] = [];
  if (ys.length >= 2) {
    const yf = ys[0], yr = ys[ys.length - 1];
    const span = yr - yf || 1;
    rear = (total * (cog[1] - yf)) / span;
    front = total - rear;
    axles.push({ y: yf, load: front }, { y: yr, load: rear });
  } else {
    v.nodes.forEach((n, i) => {
      if (n.y <= cog[1]) front += nodeWeight(v, i);
      else rear += nodeWeight(v, i);
    });
  }
  return {
    total, cog,
    byPart: [...parts.entries()].map(([part, e]) => ({ part, ...e })).sort((a, b) => b.mass - a.mass),
    front, rear, left, right, axles,
  };
}
