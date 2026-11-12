/**
 * Port of lua/common/jbeam/utils.lua node transform handling:
 * nodeRotate / nodeOffset / nodeMove (with optional 2-digit suffix ordering).
 * Math conventions match BeamNG's mathlib (vector rotation uses the conjugate form).
 */

export interface Quat { x: number; y: number; z: number; w: number }
export interface V3 { x: number; y: number; z: number }

const RAD = Math.PI / 180;

/** radians, same euler parametrization as MatrixF (ZXY intrinsic) */
export function quatFromEulerBng(x: number, y: number, z: number): Quat {
  x *= 0.5; y *= 0.5; z *= 0.5;
  const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
  return {
    x: cz * sx * cy - sz * cx * sy,
    y: cz * cx * sy + sz * sx * cy,
    z: sz * cx * cy + cz * sx * sy,
    w: cz * cx * cy - sz * sx * sy,
  };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y + a.y * b.w + a.z * b.x - a.x * b.z,
    z: a.w * b.z + a.z * b.w + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatInverse(q: Quat): Quat {
  const n = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w || 1;
  return { x: -q.x / n, y: -q.y / n, z: -q.z / n, w: q.w / n };
}

/** BeamNG's vec3:setRotate(q) */
export function rotateBng(q: Quat, x: number, y: number, z: number): V3 {
  // t = 2 * (q.xyz cross v)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return {
    x: x - tx * q.w + (q.y * tz - q.z * ty),
    y: y - ty * q.w + (q.z * tx - q.x * tz),
    z: z - tz * q.w + (q.x * ty - q.y * tx),
  };
}

export function quatToEulerBng(q: Quat): V3 {
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z, ww = w * w;
  const cxsy = 2 * (w * y - x * z), cxcy = ww - xx - yy + zz;
  const cx = Math.sqrt(cxsy * cxsy + cxcy * cxcy);
  const ex = Math.atan2(2 * (y * z + w * x), cx);
  if (cx < 1e-7) return { x: ex, y: 0, z: Math.atan2(2 * (x * y + w * z), ww + xx - yy - zz) };
  return { x: ex, y: Math.atan2(cxsy, cxcy), z: Math.atan2(2 * (w * z - x * y), ww - xx + yy - zz) };
}

interface Op { x: number; y: number; z: number; px?: any; py?: any; pz?: any }

export interface NodeXform {
  /** true when nothing applies */
  identity: boolean;
  hasRot: boolean;
  rot: Quat;
  /** translation for nodes with posX > 0, == 0 and < 0 respectively (nodeOffset.x is mirrored by sign of posX) */
  tPos: V3;
  tZero: V3;
  tNeg: V3;
}

const IDENTITY: NodeXform = {
  identity: true,
  hasRot: false,
  rot: { x: 0, y: 0, z: 0, w: 1 },
  tPos: { x: 0, y: 0, z: 0 },
  tZero: { x: 0, y: 0, z: 0 },
  tNeg: { x: 0, y: 0, z: 0 },
};

function isOp(d: any): d is Op {
  return d !== null && typeof d === 'object' && typeof d.x === 'number' && typeof d.y === 'number' && typeof d.z === 'number';
}

function opIndex(key: string, prefixLen: number): number {
  const c1 = key.charCodeAt(prefixLen);
  const c2 = key.charCodeAt(prefixLen + 1);
  let idx = Number.isNaN(c1) ? 0 : c1 - 48;
  if (!Number.isNaN(c2)) idx = idx * 10 + c2 - 48;
  return idx;
}

function compute(rots: Map<number, Op>, offs: Map<number, Op>, moves: Map<number, Op>, sign: number): { rot: Quat; t: V3 } {
  let rot: Quat = { x: 0, y: 0, z: 0, w: 1 };
  let px = 0, py = 0, pz = 0;
  const idxs = new Set<number>([...rots.keys(), ...offs.keys(), ...moves.keys()]);
  const sorted = [...idxs].sort((a, b) => a - b);
  for (const i of sorted) {
    const r = rots.get(i);
    if (r) {
      const cx = typeof r.px === 'number' ? r.px : 0;
      const cy = typeof r.py === 'number' ? r.py : 0;
      const cz = typeof r.pz === 'number' ? r.pz : 0;
      const q = quatFromEulerBng(-r.x * RAD, -r.y * RAD, -r.z * RAD);
      const rv = rotateBng(q, cx, cy, cz);
      const d = rotateBng(rot, cx - rv.x, cy - rv.y, cz - rv.z);
      px += d.x; py += d.y; pz += d.z;
      rot = quatMul(q, rot);
    }
    const o = offs.get(i);
    if (o) {
      const d = rotateBng(rot, sign * o.x, o.y, o.z);
      px += d.x; py += d.y; pz += d.z;
    }
    const m = moves.get(i);
    if (m) {
      const d = rotateBng(rot, m.x, m.y, m.z);
      px += d.x; py += d.y; pz += d.z;
    }
  }
  return { rot, t: { x: px, y: py, z: pz } };
}

const cache = new WeakMap<object, NodeXform>();

/**
 * Collects nodeRotate/nodeOffset/nodeMove operators from a row's merged options.
 * `keyObj` is used as a cache key (rows sharing the same option object share the transform).
 */
export function getNodeXform(data: Record<string, any>, keyObj?: object): NodeXform {
  if (keyObj) {
    const c = cache.get(keyObj);
    if (c) return c;
  }
  let rots: Map<number, Op> | null = null;
  let offs: Map<number, Op> | null = null;
  let moves: Map<number, Op> | null = null;
  const ignoreOffset = !!data.ignoreNodeOffset;
  for (const key in data) {
    if (key.charCodeAt(0) !== 110 /* n */ || !key.startsWith('node')) continue;
    const d = data[key];
    if (!isOp(d)) continue;
    if (key.startsWith('Rotate', 4)) {
      (rots ??= new Map()).set(opIndex(key, 10), d);
    } else if (key.startsWith('Offset', 4)) {
      if (!ignoreOffset) (offs ??= new Map()).set(opIndex(key, 10), d);
    } else if (key.startsWith('Move', 4)) {
      (moves ??= new Map()).set(opIndex(key, 8), d);
    }
  }
  let res: NodeXform;
  if (!rots && !offs && !moves) {
    res = IDENTITY;
  } else {
    const r = rots ?? new Map(), o = offs ?? new Map(), m = moves ?? new Map();
    const p = compute(r, o, m, 1);
    const hasOff = o.size > 0;
    res = {
      identity: false,
      hasRot: r.size > 0,
      rot: p.rot,
      tPos: p.t,
      tZero: hasOff ? compute(r, o, m, 0).t : p.t,
      tNeg: hasOff ? compute(r, o, m, -1).t : p.t,
    };
  }
  if (keyObj) cache.set(keyObj, res);
  return res;
}

export function applyNodeXform(xf: NodeXform, x: number, y: number, z: number): V3 {
  if (xf.identity) return { x, y, z };
  const t = x > 0 ? xf.tPos : x < 0 ? xf.tNeg : xf.tZero;
  if (xf.hasRot) {
    const r = rotateBng(xf.rot, x, y, z);
    return { x: r.x + t.x, y: r.y + t.y, z: r.z + t.z };
  }
  return { x: x + t.x, y: y + t.y, z: z + t.z };
}

/**
 * Inverse: given a final (displayed) position, returns the raw jbeam position that produces it.
 * Mirrors getPosRotBeforeNodeRotateOffsetMove: tries the +x, 0 and -x branches.
 */
export function invertNodeXform(xf: NodeXform, x: number, y: number, z: number): V3 {
  if (xf.identity) return { x, y, z };
  const inv = xf.hasRot ? quatInverse(xf.rot) : null;
  const solve = (t: V3): V3 => {
    const dx = x - t.x, dy = y - t.y, dz = z - t.z;
    return inv ? rotateBng(inv, dx, dy, dz) : { x: dx, y: dy, z: dz };
  };
  const EPS = 1e-9;
  let r = solve(xf.tPos);
  if (r.x > EPS) return r;
  r = solve(xf.tZero);
  if (Math.abs(r.x) <= EPS) return { x: 0, y: r.y, z: r.z };
  return solve(xf.tNeg);
}

/** Flexbody pos/rot after node transforms (meshs.lua). Returns null when nothing applies. */
export function flexbodyXform(
  xf: NodeXform, x: number, y: number, z: number, rx: number, ry: number, rz: number,
): { pos: V3; rot: V3 | null } | null {
  if (xf.identity) return null;
  const t = x > 0 ? xf.tPos : x < 0 ? xf.tNeg : xf.tZero;
  if (xf.hasRot) {
    const p = rotateBng(xf.rot, x, y, z);
    const q = quatMul(xf.rot, quatFromEulerBng(-rx * RAD, -ry * RAD, -rz * RAD));
    const e = quatToEulerBng(q);
    return { pos: { x: p.x + t.x, y: p.y + t.y, z: p.z + t.z }, rot: { x: -e.x / RAD, y: -e.y / RAD, z: -e.z / RAD } };
  }
  return { pos: { x: x + t.x, y: y + t.y, z: z + t.z }, rot: null };
}
