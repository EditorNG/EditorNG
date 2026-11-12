/**
 * Generic suspension kinematics for any JBeam suspension (double wishbone, strut, multilink,
 * solid axle, leaf, trailing arm, procedural...): there is no suspension-type template.
 *
 * Model:
 *  - "free" nodes = nodes of suspension-like parts (name/slotType pattern, user-overridable)
 *    plus the wheel axle nodes. Every other node is fixed (the body is the reference).
 *  - rigid beams (stiff, non-bounded) between nodes become distance constraints;
 *    springs, dampers, bump stops and other compliant beams are ignored (they are what moves).
 *  - steering hydros become length-driven constraints.
 *  - a wheel-centre height target drives the mechanism; a position-based Gauss-Seidel
 *    solver finds the pose. Measurements come from the solved poses.
 */
import type { Vehicle, VWheel } from '../jbeam/types';

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const DEG = 180 / Math.PI;

export interface SuspOptions {
  rigidThreshold: number;
  partPattern: string;
  /** parts forced free / fixed (override the pattern) */
  forceFree?: string[];
  forceFixed?: string[];
  travel: number;
  steps: number;
  /** fraction of braking done by the front axle, for anti-dive */
  frontBrakeFraction?: number;
}

export interface Corner {
  wheel: number;
  name: string;
  side: 1 | -1; // +1 left (+X), -1 right
  axle: 'front' | 'rear';
  center: V;
  contact: V;
  radius: number;
}

export interface SpringInfo {
  beam: number;
  name: string;
  kind: 'spring' | 'damper' | 'bound' | 'other';
  k: number;
  damp: number;
  motionRatio: number;
  wheelRate: number;
}

export interface CornerStatic {
  corner: Corner;
  camber: number;
  toe: number;
  caster: number | null;
  kpi: number | null;
  scrub: number | null;
  trail: number | null;
  steerAxisSource: 'jbeam' | 'computed' | null;
  /** front view instant centre (x, z), null = parallel (infinite) */
  ic: [number, number] | null;
  /** side view instant centre (y, z) */
  svic: [number, number] | null;
  springs: SpringInfo[];
  unsprungNodes: number;
}

export interface Curve {
  travel: number[];
  camber: number[];
  toe: number[];
  trackChange: number[];
  wheelbaseChange: number[];
  rcHeight: number[];
}

export interface AxleResult {
  axle: 'front' | 'rear';
  corners: CornerStatic[];
  rollCenter: [number, number] | null;
  track: number;
  curves: Record<string, Curve>; // per corner name
  /** heave curves for roll centre */
  rcCurve: { travel: number[]; height: number[] };
}

export interface SteeringResult {
  input: number[];
  left: number[];
  right: number[];
  ideal: number[];
  ackermannPct: number | null;
  maxLeft: number;
  maxRight: number;
  hydros: number;
}

export interface SuspResult {
  freeNodes: number;
  fixedNodes: number;
  rigidBeams: number;
  compliantBeams: number;
  freeParts: string[];
  axles: AxleResult[];
  steering: SteeringResult | null;
  wheelbase: number;
  cogHeight: number;
  antiDive: number | null;
  antiSquat: number | null;
  warnings: string[];
  residual: number;
}

interface Con {
  a: number;
  b: number;
  rest: number;
  hydro?: { ratio: (input: number) => number };
}

export class SuspModel {
  pos: Float64Array;
  init: Float64Array;
  free: Uint8Array;
  cons: Con[] = [];
  compliant: number[] = [];
  corners: Corner[] = [];
  freeParts: string[] = [];
  warnings: string[] = [];
  residual = 0;

  constructor(readonly v: Vehicle, readonly o: SuspOptions) {
    const n = v.nodes.length;
    this.pos = new Float64Array(n * 3);
    v.nodes.forEach((nd, i) => this.pos.set([nd.x, nd.y, nd.z], i * 3));
    this.init = this.pos.slice();
    this.free = new Uint8Array(n);
    let re: RegExp;
    try {
      re = new RegExp(o.partPattern, 'i');
    } catch {
      re = /suspension/i;
    }
    const freeParts = new Set<string>();
    for (const p of v.parts) {
      const name = p.def.name;
      const st = p.def.slotTypes.join(' ');
      if (o.forceFixed?.includes(name)) continue;
      if (o.forceFree?.includes(name) || re.test(name) || re.test(st)) freeParts.add(name);
    }
    this.freeParts = [...freeParts];
    v.nodes.forEach((nd, i) => {
      if (freeParts.has(nd.row.part.def.name)) this.free[i] = 1;
    });
    for (const w of v.wheels) {
      this.free[w.n1] = 1;
      this.free[w.n2] = 1;
    }
    // constraints
    v.beams.forEach((b, i) => {
      if (!this.free[b.a] && !this.free[b.b]) return;
      const r = b.row.v;
      const L = this.dist(b.a, b.b);
      if (L < 1e-6) return;
      if (b.type === 'HYDRO') {
        const src = r.inputSource ?? 'steering';
        if (src === 'steering') {
          this.cons.push({ a: b.a, b: b.b, rest: L, hydro: { ratio: hydroRatio(r, L) } });
          return;
        }
        this.cons.push({ a: b.a, b: b.b, rest: L });
        return;
      }
      // modifier resets leave keys as "" — treat anything non-numeric as unset
      const num = (x: any) => (typeof x === 'number' ? x : NaN);
      const k = num(r.beamSpring);
      const precomp = num(r.beamPrecompression);
      const isCompliant =
        b.type === 'BOUNDED' || b.type === 'SUPPORT' || b.type === 'PRESSURED' || b.type === 'ANISOTROPIC' ||
        (Number.isFinite(k) && k < o.rigidThreshold) ||
        // small precompression = alignment adjustment (toe/camber links); large = preloaded spring
        (Number.isFinite(precomp) && Math.abs(precomp - 1) > 0.05);
      if (isCompliant) this.compliant.push(i);
      else this.cons.push({ a: b.a, b: b.b, rest: Number.isFinite(precomp) ? L * precomp : L });
    });
    // corners
    const wheelYs = v.wheels.map((w) => (v.nodes[w.n1].y + v.nodes[w.n2].y) / 2);
    const midY = wheelYs.length ? (Math.min(...wheelYs) + Math.max(...wheelYs)) / 2 : 0;
    v.wheels.forEach((w, i) => {
      const c = this.wheelCenter(w);
      this.corners.push({
        wheel: i,
        name: w.name || `wheel${i}`,
        side: c[0] >= 0 ? 1 : -1,
        axle: c[1] <= midY ? 'front' : 'rear',
        center: c,
        contact: [c[0], c[1], c[2] - w.radius],
        radius: w.radius,
      });
    });
    if (!this.cons.length) this.warnings.push('No rigid suspension beams found — check the part pattern and the rigid threshold.');
  }

  dist(a: number, b: number): number {
    const p = this.pos;
    return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  }

  P(i: number): V {
    return [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
  }

  wheelCenter(w: VWheel): V {
    const a = this.P(w.n1), b = this.P(w.n2);
    const axis = norm(sub(b, a));
    return add(mul(add(a, b), 0.5), mul(axis, w.wheelOffset));
  }

  /** outward wheel axis (unit), pointing away from the vehicle centre */
  wheelAxis(w: VWheel): V {
    const a = this.P(w.n1), b = this.P(w.n2);
    let ax = norm(sub(b, a));
    const c = mul(add(a, b), 0.5);
    if (ax[0] * c[0] < 0) ax = mul(ax, -1);
    return ax;
  }

  reset() {
    this.pos.set(this.init);
  }

  /**
   * Solves the free nodes. `targets`: wheel index -> wheel centre z. `steer`: steering input -1..1.
   */
  solve(targets: Map<number, number>, steer = 0, iters = 260): number {
    const p = this.pos;
    const free = this.free;
    const wheels = this.v.wheels;
    let resid = 0;
    for (let it = 0; it < iters; it++) {
      resid = 0;
      for (const c of this.cons) {
        const rest = c.hydro ? c.rest * c.hydro.ratio(steer) : c.rest;
        const a = c.a * 3, b = c.b * 3;
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-9;
        const err = d - rest;
        if (Math.abs(err) > resid) resid = Math.abs(err);
        const fa = free[c.a], fb = free[c.b];
        if (!fa && !fb) continue;
        const wa = fa ? (fb ? 0.5 : 1) : 0;
        const wb = fb ? (fa ? 0.5 : 1) : 0;
        const k = err / d;
        p[a] += dx * k * wa;
        p[a + 1] += dy * k * wa;
        p[a + 2] += dz * k * wa;
        p[b] -= dx * k * wb;
        p[b + 1] -= dy * k * wb;
        p[b + 2] -= dz * k * wb;
      }
      for (const [wi, z] of targets) {
        const w = wheels[wi];
        const cz = (p[w.n1 * 3 + 2] + p[w.n2 * 3 + 2]) / 2;
        const dz = z - cz;
        p[w.n1 * 3 + 2] += dz;
        p[w.n2 * 3 + 2] += dz;
      }
      if (resid < 1e-7 && it > 10) break;
    }
    this.residual = resid;
    return resid;
  }

  /** Nodes rigidly attached to the hub (axle nodes + free nodes sharing rigid beams with both). */
  hubCluster(w: VWheel): number[] {
    const set = new Set<number>([w.n1, w.n2]);
    const nb = new Map<number, Set<number>>();
    for (const c of this.cons) {
      if (c.hydro) continue;
      (nb.get(c.a) ?? nb.set(c.a, new Set()).get(c.a)!).add(c.b);
      (nb.get(c.b) ?? nb.set(c.b, new Set()).get(c.b)!).add(c.a);
    }
    // grow: a free node joins when it has >= 3 rigid links into the cluster (or 2 when cluster is just the axle)
    for (let pass = 0; pass < 6; pass++) {
      let grew = false;
      for (const [i, s] of nb) {
        if (set.has(i) || !this.free[i]) continue;
        let links = 0;
        for (const j of s) if (set.has(j)) links++;
        if (links >= Math.min(3, set.size)) {
          set.add(i);
          grew = true;
        }
      }
      if (!grew) break;
    }
    return [...set];
  }
}

/** Length ratio of a steering hydro for an input -1..1 (mirrors nodeBeam.lua processHydros). */
function hydroRatio(r: Record<string, any>, L: number): (input: number) => number {
  let inLimit = typeof r.inLimit === 'number' ? r.inLimit : 0;
  let outLimit = typeof r.outLimit === 'number' ? r.outLimit : 2;
  let inputFactor = typeof r.inputFactor === 'number' ? r.inputFactor : 1;
  if (typeof r.inExtent === 'number') inLimit = r.inExtent / (L + 1e-30);
  if (typeof r.outExtent === 'number') outLimit = r.outExtent / (L + 1e-30);
  let factor = typeof r.factor === 'number' ? r.factor : undefined;
  if (typeof r.extentFactor === 'number') factor = r.extentFactor / (L + 1e-30);
  if (factor !== undefined) {
    inLimit = 1 - Math.abs(factor);
    outLimit = 1 + Math.abs(factor);
    inputFactor = Math.sign(factor) || 1;
  }
  return (input: number) => {
    const v = Math.max(-1, Math.min(1, input * inputFactor));
    return v >= 0 ? 1 + v * (outLimit - 1) : 1 + v * (1 - inLimit);
  };
}

/** Least-squares rigid body velocity (v at centroid, omega) from point displacements. */
function bodyMotion(p0: V[], p1: V[]): { c: V; v: V; w: V } {
  const n = p0.length;
  const c: V = [0, 0, 0];
  const v: V = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      c[k] += p0[i][k] / n;
      v[k] += (p1[i][k] - p0[i][k]) / n;
    }
  }
  // solve sum( [r]x^T [r]x ) w = sum( r x dv ), small rotation approximation
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bvec: V = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = sub(p0[i], c);
    const dv = sub(sub(p1[i], p0[i]), v);
    const rr = dot(r, r);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a * 3 + b] += (a === b ? rr : 0) - r[a] * r[b];
    const cr = cross(r, dv);
    bvec[0] += cr[0];
    bvec[1] += cr[1];
    bvec[2] += cr[2];
  }
  const w = solve3(A, bvec);
  return { c, v, w };
}

function solve3(A: number[], b: V): V {
  const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-14) return [0, 0, 0];
  const out: V = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const m = A.slice();
    m[k] = b[0];
    m[3 + k] = b[1];
    m[6 + k] = b[2];
    out[k] = det(m) / D;
  }
  return out;
}

function velAt(m: { c: V; v: V; w: V }, p: V): V {
  return add(m.v, cross(m.w, sub(p, m.c)));
}

/** 2D instant centre from two points and their velocities (coords u, w of a plane). */
function ic2d(p1: [number, number], v1: [number, number], p2: [number, number], v2: [number, number]): [number, number] | null {
  // (P - p1).v1 = 0 ; (P - p2).v2 = 0
  const a11 = v1[0], a12 = v1[1], a21 = v2[0], a22 = v2[1];
  const b1 = p1[0] * v1[0] + p1[1] * v1[1];
  const b2 = p2[0] * v2[0] + p2[1] * v2[1];
  const D = a11 * a22 - a12 * a21;
  if (Math.abs(D) < 1e-12) return null;
  return [(b1 * a22 - a12 * b2) / D, (a11 * b2 - b1 * a21) / D];
}

function lineIntersect(p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): [number, number] | null {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-12) return null;
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

// ------------------------------------------------------------------------------------------

export function analyzeSuspension(v: Vehicle, o: SuspOptions, cogZ = 0.5): SuspResult {
  const m = new SuspModel(v, o);
  const out: SuspResult = {
    freeNodes: 0,
    fixedNodes: 0,
    rigidBeams: m.cons.length,
    compliantBeams: m.compliant.length,
    freeParts: m.freeParts,
    axles: [],
    steering: null,
    wheelbase: 0,
    cogHeight: 0,
    antiDive: null,
    antiSquat: null,
    warnings: m.warnings,
    residual: 0,
  };
  for (let i = 0; i < m.free.length; i++) (m.free[i] ? out.freeNodes++ : out.fixedNodes++);
  if (!v.wheels.length) {
    out.warnings.push('No wheels found (pressureWheels / hubWheels).');
    return out;
  }
  // settle the static pose so the measurements start from a consistent state
  m.solve(new Map(), 0, 120);
  m.init.set(m.pos);
  const groundZ = Math.min(...m.corners.map((c) => c.contact[2]));
  const fronts = m.corners.filter((c) => c.axle === 'front');
  const rears = m.corners.filter((c) => c.axle === 'rear');
  const yF = fronts.length ? fronts.reduce((s, c) => s + c.center[1], 0) / fronts.length : 0;
  const yR = rears.length ? rears.reduce((s, c) => s + c.center[1], 0) / rears.length : 0;
  out.wheelbase = Math.abs(yR - yF);
  out.cogHeight = cogZ - groundZ;

  const measure = (c: Corner) => {
    const w = v.wheels[c.wheel];
    const ax = m.wheelAxis(w);
    const center = m.wheelCenter(w);
    const contact: V = [center[0], center[1], center[2] - c.radius];
    return {
      // positive camber = wheel top leaning outward = outward axis tilted down
      camber: -Math.asin(Math.max(-1, Math.min(1, ax[2]))) * DEG,
      toe: Math.atan2(-ax[1], Math.abs(ax[0])) * DEG,
      center,
      contact,
      yaw: Math.atan2(ax[1] * Math.sign(ax[0] || 1), Math.abs(ax[0])) * DEG,
    };
  };

  const DT = 0.004;
  const icsFor = (c: Corner): { fv: [number, number] | null; sv: [number, number] | null } => {
    const w = v.wheels[c.wheel];
    const cl = m.hubCluster(w);
    const p0 = cl.map((i) => m.P(i));
    const base = measure(c);
    const save = m.pos.slice();
    m.solve(new Map([[c.wheel, base.center[2] + DT]]), 0, 200);
    const p1 = cl.map((i) => m.P(i));
    m.pos.set(save);
    const mo = bodyMotion(p0, p1);
    const vc = velAt(mo, base.contact);
    const vw = velAt(mo, base.center);
    const fv = ic2d([base.contact[0], base.contact[2]], [vc[0], vc[2]], [base.center[0], base.center[2]], [vw[0], vw[2]]);
    const sv = ic2d([base.contact[1], base.contact[2]], [vc[1], vc[2]], [base.center[1], base.center[2]], [vw[1], vw[2]]);
    return { fv, sv };
  };

  const steerHydros = m.cons.filter((x) => x.hydro).length;

  const steerAxisFor = (c: Corner): { up: V; down: V; src: 'jbeam' | 'computed' } | null => {
    const w = v.wheels[c.wheel];
    const r = w.row.v;
    const up = r['steerAxisUp:'], down = r['steerAxisDown:'];
    const iu = typeof up === 'string' ? v.nodeIndex.get(up) : undefined;
    const id = typeof down === 'string' ? v.nodeIndex.get(down) : undefined;
    if (iu !== undefined && id !== undefined) return { up: m.P(iu), down: m.P(id), src: 'jbeam' };
    if (!steerHydros) return null;
    // computed from the hub motion under a small steering input
    const cl = m.hubCluster(w);
    const p0 = cl.map((i) => m.P(i));
    const save = m.pos.slice();
    m.solve(new Map(), 0.02, 200);
    const p1 = cl.map((i) => m.P(i));
    m.pos.set(save);
    const mo = bodyMotion(p0, p1);
    const wl = len(mo.w);
    if (wl < 1e-7) return null;
    const dir = norm(mo.w[2] < 0 ? mul(mo.w, -1) : mo.w);
    // point on axis: v = w x (c - a) + v_axis(parallel) -> a = c + (w x v)/|w|^2 (closest point)
    const a = add(mo.c, mul(cross(mo.w, mo.v), 1 / (wl * wl)));
    return { up: add(a, mul(dir, 0.15)), down: sub(a, mul(dir, 0.15)), src: 'computed' };
  };

  for (const [axleName, list] of [['front', fronts], ['rear', rears]] as const) {
    if (!list.length) continue;
    const axle: AxleResult = { axle: axleName, corners: [], rollCenter: null, track: 0, curves: {}, rcCurve: { travel: [], height: [] } };
    for (const c of list) {
      m.reset();
      const s = measure(c);
      const ics = icsFor(c);
      const sa = steerAxisFor(c);
      let caster: number | null = null, kpi: number | null = null, scrub: number | null = null, trail: number | null = null;
      if (sa) {
        const d = sub(sa.up, sa.down);
        caster = Math.atan2(d[1], d[2]) * DEG; // top rearward = positive
        kpi = Math.atan2(-d[0] * c.side, d[2]) * DEG; // top inboard = positive
        const t = (s.contact[2] - sa.down[2]) / (d[2] || 1e-9);
        const g: V = add(sa.down, mul(d, t));
        scrub = (s.contact[0] - g[0]) * c.side;
        trail = s.contact[1] - g[1];
      }
      // springs / dampers attached to this corner: length change per wheel travel
      const springs: SpringInfo[] = [];
      const base = m.pos.slice();
      const lens0 = m.compliant.map((bi) => m.dist(v.beams[bi].a, v.beams[bi].b));
      m.solve(new Map([[c.wheel, s.center[2] + 0.01]]), 0, 220);
      m.compliant.forEach((bi, k) => {
        const b = v.beams[bi];
        const dl = m.dist(b.a, b.b) - lens0[k];
        const mr = Math.abs(dl) / 0.01;
        if (mr < 0.05) return;
        const r = b.row.v;
        const kk = typeof r.beamSpring === 'number' ? r.beamSpring : 0;
        const damp = typeof r.beamDamp === 'number' ? r.beamDamp : 0;
        const kind: SpringInfo['kind'] = b.type === 'BOUNDED' ? (kk > 0 && kk < 1e5 ? 'spring' : 'bound') : kk > 1000 ? 'spring' : damp > 0 ? 'damper' : 'other';
        springs.push({ beam: bi, name: `${v.nodes[b.a].name} — ${v.nodes[b.b].name}`, kind, k: kk, damp, motionRatio: mr, wheelRate: kk * mr * mr });
      });
      m.pos.set(base);
      springs.sort((a, b) => b.wheelRate - a.wheelRate);
      axle.corners.push({
        corner: c, camber: s.camber, toe: s.toe, caster, kpi, scrub, trail, steerAxisSource: sa?.src ?? null,
        ic: ics.fv, svic: ics.sv, springs: springs.slice(0, 8), unsprungNodes: m.hubCluster(v.wheels[c.wheel]).length,
      });
    }
    // roll centre (front view): lines contact->IC of left and right corners
    const L = axle.corners.find((x) => x.corner.side === 1);
    const R = axle.corners.find((x) => x.corner.side === -1);
    const rcOf = (l: CornerStatic | undefined, r: CornerStatic | undefined, cl?: V, cr?: V): [number, number] | null => {
      if (!l || !r) return null;
      const lc = cl ?? l.corner.contact, rc = cr ?? r.corner.contact;
      // parallel links: IC at infinity -> line through the contact patch along the link direction is unknown; use horizontal
      const li: [number, number] = l.ic ?? [lc[0] - 100 * l.corner.side, lc[2]];
      const ri: [number, number] = r.ic ?? [rc[0] - 100 * r.corner.side, rc[2]];
      return lineIntersect([lc[0], lc[2]], li, [rc[0], rc[2]], ri);
    };
    const rc = rcOf(L, R);
    axle.rollCenter = rc ? [rc[0], rc[1] - groundZ] : null;
    if (L && R) axle.track = Math.abs(L.corner.contact[0] - R.corner.contact[0]);

    // curves: heave sweep (both wheels of the axle together)
    const steps = Math.max(3, o.steps | 0);
    const travel: number[] = [];
    for (let i = 0; i < steps; i++) travel.push(-o.travel + (2 * o.travel * i) / (steps - 1));
    const order = travel.map((t, i) => ({ t, i })).sort((a, b) => Math.abs(a.t) - Math.abs(b.t));
    for (const c of axle.corners) {
      axle.curves[c.corner.name] = { travel, camber: new Array(steps), toe: new Array(steps), trackChange: new Array(steps), wheelbaseChange: new Array(steps), rcHeight: new Array(steps) };
    }
    const rcH: number[] = new Array(steps);
    // sweep outward from 0 in both directions for good warm starts
    for (const dirSign of [1, -1]) {
      m.reset();
      for (const { t, i } of order) {
        if (t * dirSign < 0 || (t === 0 && dirSign < 0)) continue;
        const targets = new Map<number, number>();
        for (const c of axle.corners) targets.set(c.corner.wheel, c.corner.center[2] + t);
        m.solve(targets, 0, 300);
        for (const c of axle.corners) {
          const s = measure(c.corner);
          const cv = axle.curves[c.corner.name];
          cv.camber[i] = s.camber;
          cv.toe[i] = s.toe;
          cv.trackChange[i] = (s.contact[0] - c.corner.contact[0]) * c.corner.side * 1000;
          cv.wheelbaseChange[i] = (s.contact[1] - c.corner.contact[1]) * 1000;
        }
        // roll centre at this heave position
        if (L && R) {
          const save = m.pos.slice();
          const icL = (() => {
            const wL = v.wheels[L.corner.wheel];
            const cl = m.hubCluster(wL);
            const p0 = cl.map((k) => m.P(k));
            const sL = measure(L.corner);
            m.solve(new Map([...targets, [L.corner.wheel, sL.center[2] + DT]]), 0, 150);
            const mo = bodyMotion(p0, cl.map((k) => m.P(k)));
            m.pos.set(save);
            const vc = velAt(mo, sL.contact), vw = velAt(mo, sL.center);
            return { ic: ic2d([sL.contact[0], sL.contact[2]], [vc[0], vc[2]], [sL.center[0], sL.center[2]], [vw[0], vw[2]]), contact: sL.contact };
          })();
          const icR = (() => {
            const wR = v.wheels[R.corner.wheel];
            const cl = m.hubCluster(wR);
            const p0 = cl.map((k) => m.P(k));
            const sR = measure(R.corner);
            m.solve(new Map([...targets, [R.corner.wheel, sR.center[2] + DT]]), 0, 150);
            const mo = bodyMotion(p0, cl.map((k) => m.P(k)));
            m.pos.set(save);
            const vc = velAt(mo, sR.contact), vw = velAt(mo, sR.center);
            return { ic: ic2d([sR.contact[0], sR.contact[2]], [vc[0], vc[2]], [sR.center[0], sR.center[2]], [vw[0], vw[2]]), contact: sR.contact };
          })();
          const r2 = rcOf({ ...L, ic: icL.ic }, { ...R, ic: icR.ic }, icL.contact, icR.contact);
          const h = r2 ? r2[1] - (groundZ + t) : NaN;
          // near-parallel links put the IC at infinity; such roll centres are numerically meaningless
          rcH[i] = Math.abs(h) < 2 ? h : NaN;
        }
      }
    }
    for (const c of axle.corners) axle.curves[c.corner.name].rcHeight = rcH;
    axle.rcCurve = { travel, height: rcH };
    out.axles.push(axle);
  }

  // steering sweep
  if (steerHydros && fronts.length) {
    m.reset();
    const input: number[] = [];
    for (let i = 0; i <= 40; i++) input.push(-1 + i / 20);
    const left: number[] = [], right: number[] = [], ideal: number[] = [];
    const L = fronts.find((c) => c.side === 1), R = fronts.find((c) => c.side === -1);
    const yaw0L = L ? measure(L).yaw : 0, yaw0R = R ? measure(R).yaw : 0;
    const track = L && R ? Math.abs(L.contact[0] - R.contact[0]) : 1.5;
    const order = input.map((t, i) => ({ t, i })).sort((a, b) => Math.abs(a.t) - Math.abs(b.t));
    const resL: number[] = new Array(input.length), resR: number[] = new Array(input.length);
    for (const dirSign of [1, -1]) {
      m.reset();
      for (const { t, i } of order) {
        if (t * dirSign < 0 || (t === 0 && dirSign < 0)) continue;
        m.solve(new Map(), t, 300);
        resL[i] = L ? measure(L).yaw - yaw0L : 0;
        resR[i] = R ? measure(R).yaw - yaw0R : 0;
      }
    }
    for (let i = 0; i < input.length; i++) {
      left.push(resL[i]);
      right.push(resR[i]);
      // ideal Ackermann for the inner wheel given the outer wheel angle
      const turningLeft = resL[i] + resR[i] > 0;
      const outer = turningLeft ? resR[i] : resL[i];
      const o2 = Math.abs(outer) / DEG;
      const wb = out.wheelbase || 2.5;
      const idealInner = o2 > 1e-4 ? Math.atan(1 / (1 / Math.tan(o2) - track / wb)) * DEG : 0;
      ideal.push(Math.sign(outer || 1) * idealInner);
    }
    const end = input.length - 1;
    const turningLeft = left[end] + right[end] > 0;
    const inner = Math.abs(turningLeft ? left[end] : right[end]);
    const outer = Math.abs(turningLeft ? right[end] : left[end]);
    const idealInner = Math.abs(ideal[end]);
    out.steering = {
      input, left, right, ideal,
      ackermannPct: idealInner - outer > 0.05 ? ((inner - outer) / (idealInner - outer)) * 100 : null,
      maxLeft: Math.max(...left.map(Math.abs)),
      maxRight: Math.max(...right.map(Math.abs)),
      hydros: steerHydros,
    };
  }

  // anti-dive / anti-squat from side view instant centres
  const fa = out.axles.find((a) => a.axle === 'front');
  const ra = out.axles.find((a) => a.axle === 'rear');
  const svAngle = (cs: CornerStatic | undefined, forward: number): number | null => {
    if (!cs?.svic) return null;
    const dy = (cs.svic[0] - cs.corner.contact[1]) * forward;
    const dz = cs.svic[1] - cs.corner.contact[2];
    return Math.atan2(dz, Math.abs(dy) < 1e-9 ? 1e-9 : dy);
  };
  if (out.wheelbase > 0 && out.cogHeight > 0) {
    const ff = o.frontBrakeFraction ?? 0.65;
    // front: IC behind the front wheel (towards +Y) and above ground gives anti-dive
    const af = svAngle(fa?.corners[0], 1);
    if (af !== null) out.antiDive = Math.tan(af) * ff * (out.wheelbase / out.cogHeight) * 100;
    const ar = svAngle(ra?.corners[0], -1);
    if (ar !== null) out.antiSquat = Math.tan(ar) * (out.wheelbase / out.cogHeight) * 100;
  }
  out.residual = m.residual;
  if (m.residual > 0.002) out.warnings.push(`Solver residual ${(m.residual * 1000).toFixed(1)} mm — the rigid beam set may over-constrain the mechanism (try a lower rigid threshold) or a part is wrongly marked free/fixed.`);
  return out;
}
