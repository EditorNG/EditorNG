/**
 * Trigger placement, ported from the game (lua/common/jbeam/sections/events.lua and the C++ basis
 * reproduced in lua/ge/extensions/core/vehicle/triggerLabelPlacement.lua), with BeamNG's own
 * quaternion conventions (mathlib.lua): Hamilton products, and vectors rotated with the
 * `v - w*t + q x t` form.
 *
 *   nx      = normalize(idX - ref)
 *   nz      = normalize(cross(idY - ref, nx))
 *   camUp   = normalize(-cross(nz, nx))
 *   q       = quatFromDir(nz); yaw so that q*Z lines up with camUp
 *   q       = Y(autoYaw + baseRot.y) -> Z(-baseRot.z) -> X(-baseRot.x)   (pre-multiplied)
 *   box axes = q*X, q*Y, q*Z ; size = full extents along them
 *   position = baseTranslationGlobal (+ nodeOffset/nodeMove/nodeRotate of the row)
 *              or ref + bt.x*nx + bt.y*camUp + bt.z*nz
 *   a box extends from the position along +axes (the position is a corner); a sphere is centred on it.
 */
import { applyNodeXform, getNodeXform } from './nodeTransform';
import type { Row, Vehicle } from './types';

export type V3 = [number, number, number];
export interface Q {
  x: number;
  y: number;
  z: number;
  w: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** mathlib LuaQuat.__mul for two quaternions */
export function qmul(a: Q, b: Q): Q {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y + a.y * b.w + a.z * b.x - a.x * b.z,
    z: a.w * b.z + a.z * b.w + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** mathlib quat * vec3 */
export function qrot(q: Q, v: V3): V3 {
  const t = mul(cross([q.x, q.y, q.z], v), 2);
  const c = cross([q.x, q.y, q.z], t);
  return [v[0] - t[0] * q.w + c[0], v[1] - t[1] * q.w + c[1], v[2] - t[2] * q.w + c[2]];
}

/** mathlib LuaQuat:setFromEuler (radians) */
export function quatFromEuler(x: number, y: number, z: number): Q {
  x *= 0.5;
  y *= 0.5;
  z *= 0.5;
  const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y), sz = Math.sin(z), cz = Math.cos(z);
  const cycz = cy * cz, sysz = sy * sz, sycz = sy * cz, cysz = cy * sz;
  return { x: cycz * sx + sysz * cx, y: sycz * cx + cysz * sx, z: cysz * cx - sycz * sx, w: cycz * cx - sysz * sx };
}

function qnormalize(q: Q): Q {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/** mathlib LuaQuat:setFromDir */
export function quatFromDir(dir: V3, up: V3 = [0, 0, 1]): Q {
  let d = norm(dir);
  if (Math.abs(dot(d, up)) > 0.9999) {
    // perpendicularN like mathlib, nudged
    const k0 = Math.abs(d[0]) + 0.5;
    const k = k0 - Math.floor(k0);
    const p = norm([-d[1], d[0] - k * d[2], k * d[1]]);
    d = norm(add(d, mul(p, 1e-5)));
  }
  const m: number[][] = [[], [], []];
  m[1] = [d[0], d[1], d[2]];
  let t = norm(cross(d, up));
  m[0] = [t[0], t[1], t[2]];
  t = norm(cross(t, d));
  m[2] = [t[0], t[1], t[2]];
  const trace = m[0][0] + m[1][1] + m[2][2];
  let q: Q;
  if (trace > 0) {
    let s = Math.sqrt(trace + 1);
    const w = s * 0.5;
    s = 0.5 / s;
    q = { x: (m[2][1] - m[1][2]) * s, y: (m[0][2] - m[2][0]) * s, z: (m[1][0] - m[0][1]) * s, w };
  } else {
    let i = 0;
    if (m[1][1] > m[0][0]) i = 1;
    if (m[2][2] > m[i][i]) i = 2;
    const j = (i + 1) % 3, k = (j + 1) % 3;
    const qq = [0, 0, 0];
    let s = Math.sqrt(m[i][i] - m[j][j] - (m[k][k] - 1));
    qq[i] = s * 0.5;
    s = 0.5 / s;
    qq[j] = (m[j][i] + m[i][j]) * s;
    qq[k] = (m[k][i] + m[i][k]) * s;
    q = { x: qq[0], y: qq[1], z: qq[2], w: (m[k][j] - m[j][k]) * s };
  }
  return qnormalize(q);
}

const DEG = Math.PI / 180;

function readXYZ(v: any, d = 0): V3 {
  if (v && typeof v === 'object') {
    const n = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return Array.isArray(v) ? [n(v[0]), n(v[1]), n(v[2])] : [n(v.x), n(v.y), n(v.z)];
  }
  if (typeof v === 'number') return [v, v, v];
  return [d, d, d];
}

export interface TriggerFrame {
  nx: V3;
  camUp: V3;
  nz: V3;
  /** final box axes after the base rotation */
  X: V3;
  Y: V3;
  Z: V3;
}

/** baseRot in degrees (as written in the jbeam). */
export function triggerFrame(ref: V3, px: V3, py: V3, baseRotDeg: V3): TriggerFrame | null {
  const xa = sub(px, ref), ya = sub(py, ref);
  if (len(xa) < 1e-5 || len(ya) < 1e-5) return null;
  const nx = norm(xa);
  const zc = cross(ya, nx);
  if (len(zc) < 1e-5) return null;
  const nz = norm(zc);
  const camUp = norm(mul(cross(nz, nx), -1));
  const [bx, by, bz] = baseRotDeg.map((a) => a * DEG);
  let q = quatFromDir(nz);
  const rotatedUp = qrot(q, [0, 0, 1]);
  const autoYaw = Math.atan2(dot(rotatedUp, nx), dot(rotatedUp, camUp));
  q = qmul(quatFromEuler(0, autoYaw + by, 0), q);
  q = qmul(quatFromEuler(0, 0, -bz), q);
  q = qmul(quatFromEuler(-bx, 0, 0), q);
  return { nx, camUp, nz, X: qrot(q, [1, 0, 0]), Y: qrot(q, [0, 1, 0]), Z: qrot(q, [0, 0, 1]) };
}

export interface TriggerPlacement {
  /** index into vehicle.triggers */
  idx: number;
  row: Row;
  name: string;
  type: 'box' | 'sphere';
  /** box corner / sphere centre */
  origin: V3;
  frame: TriggerFrame;
  size: V3;
  radius: number;
  usesGlobal: boolean;
  center: V3;
}

/** All triggers (triggers2 + legacy triggers), the way the game merges them. */
export function triggerRows(v: Vehicle): Row[] {
  return v.triggers ?? [...(v.tables.get('triggers2') ?? []), ...(v.tables.get('triggers') ?? [])];
}

export function triggerName(r: Row): string {
  const v = r.v;
  if (typeof v.label === 'string' && v.label.trim()) return v.label.trim();
  return String(v.id ?? v.name ?? '');
}

/** trigger id -> linked actions ("action0: common:toggle_headlights") from triggerEventLinks2 / legacy links */
export function triggerActions(v: Vehicle): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (id: any, s: string) => {
    if (id === undefined || id === null) return;
    const k = String(id);
    const l = out.get(k) ?? [];
    if (!l.includes(s)) l.push(s);
    out.set(k, l);
  };
  for (const r of v.tables.get('triggerEventLinks2') ?? []) push(r.v['triggerId:triggers2'] ?? r.v['triggerId:'], String(r.v.inputAction ?? ''));
  for (const r of v.tables.get('triggerEventLinks') ?? []) push(r.v['triggerId:triggers'] ?? r.v['triggerId:'], String(r.v['targetEventId:events'] ?? r.v.targetEventId ?? ''));
  return out;
}

/** "common:toggle_headlights" -> "toggle headlights" */
export function prettyAction(a: string): string {
  return a.replace(/^common:/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/** Display label: the jbeam label, else the id plus the linked actions. */
export function triggerLabel(r: Row, actions: Map<string, string[]>): string {
  const base = triggerName(r);
  const acts = actions.get(String(r.v.id ?? r.v.name ?? '')) ?? [];
  if (!acts.length) return base;
  const nice = acts.map(prettyAction).filter((a) => a && a.toLowerCase() !== base.toLowerCase().replace(/_/g, ' '));
  return nice.length ? `${base} · ${nice.join(', ')}` : base;
}

export function placeTriggers(v: Vehicle, pos: ArrayLike<number>): TriggerPlacement[] {
  const out: TriggerPlacement[] = [];
  const actions = triggerActions(v);
  triggerRows(v).forEach((row, idx) => {
    const r = row.v;
    const ri = v.nodeIndex.get(String(r['idRef:'])), xi = v.nodeIndex.get(String(r['idX:'])), yi = v.nodeIndex.get(String(r['idY:']));
    if (ri === undefined || xi === undefined || yi === undefined) return;
    const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const ref = P(ri);
    const frame = triggerFrame(ref, P(xi), P(yi), readXYZ(r.baseRotation));
    if (!frame) return;
    const gKey = ['baseTranslationGlobal', 'baseTranslationGlobalElastic', 'baseTranslationGlobalRigid'].find((k) => r[k] && typeof r[k] === 'object');
    let origin: V3;
    if (gKey) {
      const g = readXYZ(r[gKey]);
      const p = applyNodeXform(getNodeXform(r), g[0], g[1], g[2]);
      origin = [p.x, p.y, p.z];
    } else {
      const bt = readXYZ(r.baseTranslation);
      origin = add(add(add(ref, mul(frame.nx, bt[0])), mul(frame.camUp, bt[1])), mul(frame.nz, bt[2]));
    }
    const type = r.type === 'sphere' ? 'sphere' : 'box';
    const size: V3 = typeof r.size === 'number' ? [r.size, r.size, r.size] : readXYZ(r.size, 0.2);
    const center = type === 'sphere' ? origin : add(add(add(origin, mul(frame.X, size[0] / 2)), mul(frame.Y, size[1] / 2)), mul(frame.Z, size[2] / 2));
    out.push({ idx, row, name: triggerLabel(row, actions), type, origin, frame, size, radius: typeof r.size === 'number' ? r.size : size[0], usesGlobal: !!gKey, center });
  });
  return out;
}

// ------------------------------------------------------------------------------------------
// editing: world-space placement -> jbeam values
// ------------------------------------------------------------------------------------------

/** Euler base rotation (degrees) whose box axes best match the wanted axes (numeric Gauss-Newton). */
export function solveBaseRotation(ref: V3, px: V3, py: V3, want: { X: V3; Y: V3 }, guess: V3): V3 {
  const resid = (b: V3): number[] | null => {
    const f = triggerFrame(ref, px, py, b);
    if (!f) return null;
    return [...sub(f.X, want.X), ...sub(f.Y, want.Y)];
  };
  const err = (r: number[] | null) => (r ? r.reduce((s, x) => s + x * x, 0) : Infinity);
  const solveFrom = (start: V3): { b: V3; e: number } => {
    let b: V3 = [...start];
    let r = resid(b);
    let e = err(r);
    let lambda = 1e-3;
    for (let it = 0; it < 60 && e > 1e-14; it++) {
      const h = 1e-4;
      const J: number[][] = [];
      for (let k = 0; k < 3; k++) {
        const bb: V3 = [...b];
        bb[k] += h;
        const rr = resid(bb)!;
        J.push(rr.map((x, i) => (x - r![i]) / h));
      }
      // (JᵀJ + λI) δ = -Jᵀr
      const A = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J[i].reduce((s, x, n) => s + x * J[j][n], 0) + (i === j ? lambda : 0)));
      const g = [0, 1, 2].map((i) => -J[i].reduce((s, x, n) => s + x * r![n], 0));
      const d = solve3(A, g);
      if (!d) break;
      const nb: V3 = [b[0] + d[0], b[1] + d[1], b[2] + d[2]];
      const nr = resid(nb);
      const ne = err(nr);
      if (ne < e) {
        b = nb;
        r = nr;
        e = ne;
        lambda = Math.max(1e-9, lambda * 0.3);
      } else lambda *= 10;
    }
    return { b, e };
  };
  let best = solveFrom(guess);
  if (best.e > 1e-8) {
    for (const s of [[0, 0, 0], [90, 0, 0], [-90, 0, 0], [0, 90, 0], [0, -90, 0], [0, 0, 90], [0, 0, -90], [180, 0, 0], [0, 180, 0], [0, 0, 180]] as V3[]) {
      const r = solveFrom(s);
      if (r.e < best.e) best = r;
      if (best.e < 1e-10) break;
    }
  }
  // tidy: snap to clean values when that costs (almost) nothing, then wrap to (-180, 180]
  for (const step of [1, 0.1, 0.01]) {
    const c = best.b.map((x) => Math.round(x / step) * step) as V3;
    const e = err(resid(c));
    if (e < Math.max(best.e * 4, 3e-8)) {
      best = { b: c, e };
      break;
    }
  }
  return best.b.map((a) => {
    let x = ((a % 360) + 360) % 360;
    if (x > 180) x -= 360;
    return Math.abs(x) < 1e-9 ? 0 : x;
  }) as V3;
}

function solve3(A: number[][], b: number[]): V3 | null {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-18) return null;
  const col = (k: number) => A.map((row, i) => row.map((x, j) => (j === k ? b[i] : x)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

export interface TriggerTarget {
  /** new box corner / sphere centre (world) */
  origin: V3;
  /** new box axes (world); omit to keep the rotation */
  axes?: { X: V3; Y: V3; Z: V3 };
  /** new size (box) or radius (sphere, size[0]) */
  size?: V3;
}

/**
 * New jbeam values for a trigger placed at `target`: baseTranslation (node frame) or
 * baseTranslationGlobal (node transform inverted by the caller via `toRaw`), baseRotation and size.
 */
export function triggerValues(v: Vehicle, pos: ArrayLike<number>, t: TriggerPlacement, target: TriggerTarget, toRaw: (p: V3) => V3): Record<string, any> {
  const r = t.row.v;
  const P = (n: any): V3 | null => {
    const i = v.nodeIndex.get(String(n));
    return i === undefined ? null : [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  };
  const ref = P(r['idRef:'])!, px = P(r['idX:'])!, py = P(r['idY:'])!;
  const out: Record<string, any> = {};
  const cur = readXYZ(r.baseRotation);
  let rot = cur;
  if (target.axes && t.type === 'box') {
    rot = solveBaseRotation(ref, px, py, target.axes, cur);
    out.baseRotation = { x: rot[0], y: rot[1], z: rot[2] };
  }
  const frame = triggerFrame(ref, px, py, rot)!;
  const gKey = ['baseTranslationGlobal', 'baseTranslationGlobalElastic', 'baseTranslationGlobalRigid'].find((k) => r[k] && typeof r[k] === 'object');
  if (gKey) {
    const g = toRaw(target.origin);
    out[gKey] = { x: g[0], y: g[1], z: g[2] };
  } else {
    const d = sub(target.origin, ref);
    out.baseTranslation = { x: dot(d, frame.nx), y: dot(d, frame.camUp), z: dot(d, frame.nz) };
  }
  if (target.size) out.size = t.type === 'sphere' ? target.size[0] : { x: target.size[0], y: target.size[1], z: target.size[2] };
  return out;
}

/**
 * Values for the X-mirror of a trigger: the same box/sphere reflected through x = 0, expressed
 * with the mirrored reference nodes. The reflected frame flips handedness, so the box is
 * re-described with axes (refl X, refl Y, -refl Z) and its corner recomputed.
 */
export function mirroredTriggerValues(v: Vehicle, pos: ArrayLike<number>, t: TriggerPlacement, nodes: { ref: string; x: string; y: string }, toRaw: (p: V3) => V3): Record<string, any> | null {
  const refl = (a: V3): V3 => [-a[0], a[1], a[2]];
  const row = { ...t.row, v: { ...t.row.v, 'idRef:': nodes.ref, 'idX:': nodes.x, 'idY:': nodes.y } };
  for (const n of [nodes.ref, nodes.x, nodes.y]) if (!v.nodeIndex.has(n)) return null;
  const tt: TriggerPlacement = { ...t, row };
  const center = refl(t.center);
  if (t.type === 'sphere') return triggerValues(v, pos, tt, { origin: center }, toRaw);
  const X = refl(t.frame.X), Y = refl(t.frame.Y), Z = mul(refl(t.frame.Z), -1);
  const origin = sub(sub(sub(center, mul(X, t.size[0] / 2)), mul(Y, t.size[1] / 2)), mul(Z, t.size[2] / 2));
  return triggerValues(v, pos, tt, { origin, axes: { X, Y, Z } }, toRaw);
}

/**
 * The world-aligned axes closest to a box's current axes (smallest turn): each local axis maps to
 * the world axis it points most along, keeping a right-handed frame.
 */
export function worldAlignedAxes(f: { X: V3; Y: V3; Z: V3 }): { X: V3; Y: V3; Z: V3 } {
  const W: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const snap = (v: V3, not: number[]): { axis: number; v: V3 } => {
    let best = -1, bd = -1;
    for (let i = 0; i < 3; i++) {
      if (not.includes(i)) continue;
      const d = Math.abs(v[i]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    const sign = v[best] < 0 ? -1 : 1;
    return { axis: best, v: mul(W[best], sign) };
  };
  // snap the axis that is already closest to a world axis first
  const order = (['X', 'Y', 'Z'] as const).slice().sort((a, b) => Math.max(...f[b].map(Math.abs)) - Math.max(...f[a].map(Math.abs)));
  const out: Partial<Record<'X' | 'Y' | 'Z', V3>> = {};
  const used: number[] = [];
  for (const k of order.slice(0, 2)) {
    const r = snap(f[k], used);
    used.push(r.axis);
    out[k] = r.v;
  }
  // the last axis completes a right-handed frame (Z = X × Y, X = Y × Z, Y = Z × X)
  const last = order[2];
  if (last === 'Z') out.Z = cross(out.X!, out.Y!);
  else if (last === 'X') out.X = cross(out.Y!, out.Z!);
  else out.Y = cross(out.Z!, out.X!);
  return { X: out.X!, Y: out.Y!, Z: out.Z! };
}
