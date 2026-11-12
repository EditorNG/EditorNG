/**
 * Mesh -> node/beam/triangle conversion for the Blender workflow:
 * vertices become nodes, edges become beams, faces become collision triangles.
 *
 * Re-importing is safe: vertices that match an existing node position (within tolerance)
 * keep that node's name, and beams/triangles that already exist are skipped.
 */

export interface MeshData {
  name: string;
  /** flat xyz in vehicle space (Z up, -Y forward) */
  verts: number[];
  edges: number[];
  tris: number[];
  /** optional per-vertex group names */
  vertGroup?: number[];
  groups?: string[];
}

/** Parses a Wavefront OBJ (v, l, f, o/g). `axis` 'y-up' converts Blender's default OBJ export back to Z up. */
export function parseObj(text: string, axis: 'z-up' | 'y-up'): MeshData[] {
  const out: MeshData[] = [];
  const allV: number[] = [];
  let cur: MeshData | null = null;
  let map = new Map<number, number>();
  const start = (name: string) => {
    cur = { name, verts: [], edges: [], tris: [] };
    map = new Map();
    out.push(cur);
  };
  const vi = (tok: string): number => {
    let i = parseInt(tok.split('/')[0], 10);
    if (i < 0) i = allV.length / 3 + i;
    else i -= 1;
    if (!cur) start('mesh');
    let li = map.get(i);
    if (li === undefined) {
      li = cur!.verts.length / 3;
      cur!.verts.push(allV[i * 3], allV[i * 3 + 1], allV[i * 3 + 2]);
      map.set(i, li);
    }
    return li;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const t = parts[0];
    if (t === 'v') {
      let x = +parts[1], y = +parts[2], z = +parts[3];
      if (axis === 'y-up') [y, z] = [-z, y];
      allV.push(x, y, z);
    } else if (t === 'o' || t === 'g') {
      start(parts.slice(1).join(' ') || 'mesh');
    } else if (t === 'l') {
      const ids = parts.slice(1).map(vi);
      for (let i = 1; i < ids.length; i++) cur!.edges.push(ids[i - 1], ids[i]);
    } else if (t === 'f') {
      const ids = parts.slice(1).map(vi);
      for (let i = 1; i + 1 < ids.length; i++) cur!.tris.push(ids[0], ids[i], ids[i + 1]);
      // face edges become beams too (polygon outline only, no fan diagonals)
      for (let i = 0; i < ids.length; i++) cur!.edges.push(ids[i], ids[(i + 1) % ids.length]);
    }
  }
  return out.filter((m) => m.verts.length);
}

export interface ExistingNode {
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface ImportOptions {
  prefix: string;
  start: number;
  suffixL: string;
  suffixR: string;
  centerTol: number;
  mergeTol: number;
  makeBeams: boolean;
  makeTris: boolean;
  /** order for numbering new nodes */
  order: 'front-to-back' | 'top-to-bottom' | 'index';
  /** use vertex group names as node prefixes */
  groupPrefix: boolean;
}

export interface ImportPlan {
  newNodes: Array<{ name: string; x: number; y: number; z: number; group?: string }>;
  matched: number;
  beams: Array<[string, string]>;
  tris: Array<[string, string, string]>;
  skippedBeams: number;
  skippedTris: number;
  /** vertex index -> node name */
  names: string[];
}

export function planImport(meshes: MeshData[], existing: ExistingNode[], existingBeams: Set<string>, existingTris: Set<string>, o: ImportOptions): ImportPlan {
  // merge all meshes into one vertex list, welding duplicates
  const verts: number[] = [];
  const vGroup: Array<string | undefined> = [];
  const edges: Array<[number, number]> = [];
  const tris: Array<[number, number, number]> = [];
  const weld = new Map<string, number>();
  const cell = Math.max(o.mergeTol, 1e-6);
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  for (const m of meshes) {
    const local: number[] = [];
    for (let i = 0; i < m.verts.length / 3; i++) {
      const x = m.verts[i * 3], y = m.verts[i * 3 + 1], z = m.verts[i * 3 + 2];
      const k = keyOf(x, y, z);
      let idx = weld.get(k);
      if (idx === undefined) {
        idx = verts.length / 3;
        verts.push(x, y, z);
        const gi = m.vertGroup?.[i];
        vGroup.push(gi !== undefined && gi >= 0 ? m.groups?.[gi] : undefined);
        weld.set(k, idx);
      }
      local.push(idx);
    }
    for (let i = 0; i + 1 < m.edges.length; i += 2) edges.push([local[m.edges[i]], local[m.edges[i + 1]]]);
    for (let i = 0; i + 2 < m.tris.length; i += 3) tris.push([local[m.tris[i]], local[m.tris[i + 1]], local[m.tris[i + 2]]]);
  }
  const n = verts.length / 3;
  const names: string[] = new Array(n);
  // match existing nodes by position
  const exGrid = new Map<string, ExistingNode[]>();
  const tol = Math.max(o.mergeTol, 1e-6);
  const gk = (x: number, y: number, z: number) => `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
  for (const e of existing) {
    const k = gk(e.x, e.y, e.z);
    (exGrid.get(k) ?? exGrid.set(k, []).get(k)!).push(e);
  }
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol), cz = Math.floor(z / tol);
    let best: ExistingNode | null = null;
    let bd = tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const e of exGrid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        const d = Math.hypot(e.x - x, e.y - y, e.z - z);
        if (d <= bd) {
          bd = d;
          best = e;
        }
      }
    }
    if (best) {
      names[i] = best.name;
      matched++;
    }
  }
  // order new vertices and pair mirror twins so they share a number
  const taken = new Set(existing.map((e) => e.name));
  const fresh = [...Array(n).keys()].filter((i) => !names[i]);
  const sortKey = (i: number): number[] => {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    if (o.order === 'front-to-back') return [Math.round(y * 1000), -Math.round(z * 1000), -Math.abs(x)];
    if (o.order === 'top-to-bottom') return [-Math.round(z * 1000), Math.round(y * 1000), -Math.abs(x)];
    return [i];
  };
  fresh.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k];
    return a - b;
  });
  const freshSet = new Set(fresh);
  const twinOf = new Map<number, number>();
  const mirrorTol = Math.max(o.mergeTol * 2, 0.0005);
  const byPos = new Map<string, number>();
  for (const i of fresh) byPos.set(`${Math.round(verts[i * 3] / mirrorTol)},${Math.round(verts[i * 3 + 1] / mirrorTol)},${Math.round(verts[i * 3 + 2] / mirrorTol)}`, i);
  for (const i of fresh) {
    const x = verts[i * 3];
    if (Math.abs(x) <= o.centerTol || twinOf.has(i)) continue;
    const j = byPos.get(`${Math.round(-x / mirrorTol)},${Math.round(verts[i * 3 + 1] / mirrorTol)},${Math.round(verts[i * 3 + 2] / mirrorTol)}`);
    if (j !== undefined && j !== i && freshSet.has(j) && !twinOf.has(j)) {
      twinOf.set(i, j);
      twinOf.set(j, i);
    }
  }
  const counters = new Map<string, number>();
  const side = (x: number) => (x > o.centerTol ? o.suffixL : x < -o.centerTol ? o.suffixR : '');
  const newNodes: ImportPlan['newNodes'] = [];
  for (const i of fresh) {
    if (names[i]) continue;
    const prefix = o.groupPrefix && vGroup[i] ? vGroup[i]! : o.prefix;
    let num = counters.get(prefix) ?? o.start;
    const twin = twinOf.get(i);
    for (;;) {
      const a = prefix + num + side(verts[i * 3]);
      const b = twin !== undefined ? prefix + num + side(verts[twin * 3]) : null;
      if (!taken.has(a) && (!b || !taken.has(b))) break;
      num++;
    }
    counters.set(prefix, num + 1);
    const assign = (k: number) => {
      const name = prefix + num + side(verts[k * 3]);
      names[k] = name;
      taken.add(name);
      newNodes.push({ name, x: verts[k * 3], y: verts[k * 3 + 1], z: verts[k * 3 + 2], group: vGroup[k] });
    };
    assign(i);
    if (twin !== undefined && !names[twin]) assign(twin);
  }
  // beams / tris
  const bk = (a: string, b: string) => (a < b ? a + '\u0001' + b : b + '\u0001' + a);
  const tk = (a: string, b: string, c: string) => [a, b, c].sort().join('\u0001');
  const beams: Array<[string, string]> = [];
  const seenB = new Set(existingBeams);
  let skippedBeams = 0;
  if (o.makeBeams) {
    for (const [a, b] of edges) {
      if (a === b) continue;
      const k = bk(names[a], names[b]);
      if (seenB.has(k)) {
        skippedBeams++;
        continue;
      }
      seenB.add(k);
      beams.push([names[a], names[b]]);
    }
  }
  const outTris: Array<[string, string, string]> = [];
  const seenT = new Set(existingTris);
  let skippedTris = 0;
  if (o.makeTris) {
    for (const [a, b, c] of tris) {
      if (a === b || b === c || a === c) continue;
      const k = tk(names[a], names[b], names[c]);
      if (seenT.has(k)) {
        skippedTris++;
        continue;
      }
      seenT.add(k);
      outTris.push([names[a], names[b], names[c]]);
    }
  }
  return { newNodes, matched, beams, tris: outTris, skippedBeams, skippedTris, names };
}
