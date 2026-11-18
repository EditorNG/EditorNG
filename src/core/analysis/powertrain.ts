/**
 * The powertrain as editable data, and the torque curves the game derives from it.
 *
 * Devices come from the "powertrain" tables. A device's data is its section (named after the
 * device) merged across the installed parts like the game does it: a plain key replaces the value,
 * "$+key" / "$*key" / "$<key" / "$>key" add to it, scale it, cap it, floor it (ECU, internals and
 * intake parts work this way). Every key keeps the list of parts that shaped it, so a value can be
 * traced and edited where it is written. "$name" values are tuning variables (the configuration
 * sets them); other "$=" expressions can only be edited in the code.
 *
 * The curves follow lua/vehicle/powertrain/combustionEngine.lua (torque table × torqueModMult +
 * torqueModIntake + torqueModExhaust, the stall cut-off and the drop-off past maxRPM, Catmull-Rom
 * between points), turbocharger.lua / supercharger.lua (getTorqueCoefs) and
 * nitrousOxideInjection.lua (getAddedTorque), minus friction as the game's torque curve app shows.
 */
import type { Vehicle } from '../jbeam/types';
import { objGet, toJs, type ANode, type AArr, type AObj } from '../sjson';

export type Op = '=' | '+' | '*' | '<' | '>';

export interface PtCell {
  value: number;
  /** the literal in the file, null when the value is a variable / an expression / missing */
  node: ANode | null;
  /** the file it is in (when it differs from the table's) */
  file?: string;
  /** "$name": a tuning variable */
  varName?: string;
  /** the text of an expression ("$=…") */
  expr?: string;
}

/** One part's say on a key: the value it sets, or the modifier it applies. */
export interface PtSource {
  part: string;
  file: string;
  op: Op;
  cell: PtCell;
}

export interface PtProp {
  key: string;
  /** the value the game ends up with */
  value: unknown;
  /** parts that wrote it, in merge order (the last "=" first, then the modifiers after it) */
  sources: PtSource[];
}

export interface PtLutRow {
  cells: PtCell[];
  row: AArr;
}

/** A table inside a section: [["rpm","torque"], [0, 0], …] or headerless [[0, -3.5], …]. */
export interface PtLut {
  key: string;
  part: string;
  file: string;
  arr: AArr;
  header: string[] | null;
  rows: PtLutRow[];
}

export interface PtSection {
  name: string;
  props: PtProp[];
  luts: Map<string, PtLut>;
  /** effective data (merged, variables resolved) */
  data: Record<string, any>;
}

export interface TorquePoint {
  rpm: PtCell;
  torque: PtCell;
  row: AArr;
}

export interface PtEngine {
  name: string;
  type: string;
  /** part / file of the torque table */
  part: string;
  file: string;
  section: PtSection;
  turbo: PtSection | null;
  supercharger: PtSection | null;
  nitrous: PtSection | null;
  points: TorquePoint[];
  table: AArr | null;
  idleRPM: PtProp | null;
  maxRPM: PtProp | null;
  revLimiterRPM: PtProp | null;
}

export interface PtGearbox {
  name: string;
  type: string;
  part: string;
  file: string;
  /** reverse, neutral, then forward gears, as written */
  ratios: PtCell[];
  array: AArr | null;
  section: PtSection;
}

export interface PtFinalDrive {
  name: string;
  type: string;
  part: string;
  file: string;
  ratio: PtCell;
}

export interface Powertrain {
  engines: PtEngine[];
  gearboxes: PtGearbox[];
  finalDrives: PtFinalDrive[];
  /** radius of the first wheel with a tyre (m), for road speeds */
  wheelRadius: number;
}

const ENGINE = /^(combustionEngine|electricMotor)$/i;
const GEARBOX = /gearbox$/i;
const DRIVE = /^(differential|finalDrive)$/i;

/** A cell for a value node: a literal, a tuning variable, or an expression. */
export function cellOf(n: ANode | undefined | null, vars: Record<string, any>, file?: string): PtCell {
  if (!n) return { value: NaN, node: null, file };
  if (n.k === 'num') return { value: n.v, node: n, file };
  if (n.k === 'str' && /^\$[A-Za-z_]\w*$/.test(n.v)) {
    const x = vars[n.v];
    return { value: typeof x === 'number' ? x : NaN, node: null, file, varName: n.v };
  }
  if (n.k === 'str' && n.v.startsWith('$=')) return { value: NaN, node: null, file, expr: n.v };
  const v = toJs(n);
  return { value: typeof v === 'number' ? v : NaN, node: null, file };
}

const OPS: Record<string, Op> = { '+': '+', '*': '*', '<': '<', '>': '>' };

function isTable(n: ANode): n is AArr {
  return n.k === 'arr' && n.items.length > 0 && n.items.every((r) => r.k === 'arr');
}

/** A section merged across parts, with where each key came from. */
export function readSection(v: Vehicle, name: string): PtSection | null {
  const props = new Map<string, PtProp>();
  const luts = new Map<string, PtLut>();
  let any = false;
  for (const p of uniqueParts(v)) {
    const n = p.def.sections.get(name);
    if (!n || n.k !== 'obj') continue;
    any = true;
    const file = p.def.file;
    for (let i = 0; i < n.keys.length; i++) {
      const raw = n.keys[i].v;
      const val = n.vals[i];
      let key = raw, op: Op = '=';
      if (raw.charCodeAt(0) === 36 && OPS[raw[1]]) {
        op = OPS[raw[1]];
        key = raw.slice(2);
      }
      if (op === '=' && isTable(val)) {
        const head = val.items[0] as AArr;
        const header = head.items.length && head.items.every((x) => x.k === 'str') ? head.items.map((x) => String(toJs(x))) : null;
        const rows = val.items.slice(header ? 1 : 0).filter((r): r is AArr => r.k === 'arr').map((r) => ({ cells: r.items.map((c) => cellOf(c, v.vars, file)), row: r }));
        luts.set(key, { key, part: p.def.name, file, arr: val, header, rows });
        props.delete(key);
        continue;
      }
      if (val.k === 'arr' || val.k === 'obj') continue;
      const src: PtSource = { part: p.def.name, file, op, cell: cellOf(val, v.vars, file) };
      const cur = props.get(key);
      if (op === '=' || !cur) props.set(key, { key, value: undefined, sources: [src] });
      else cur.sources.push(src);
    }
  }
  if (!any) return null;
  const data = v.dicts.get(name) ?? {};
  for (const pr of props.values()) pr.value = data[pr.key] ?? data['$' + pr.sources[0]?.op + pr.key];
  return { name, props: [...props.values()], luts, data };
}

/** parts once each (a slot listed twice installs its part twice; its section is the same) */
function uniqueParts(v: Vehicle) {
  const seen = new Set<string>();
  return v.parts.filter((p) => {
    const k = p.def.file + '|' + p.def.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The base value that makes a key come out at `target` through its modifiers, or null when it
 * can't be worked back (a cap or floor in the chain).
 */
export function baseFor(p: PtProp, target: number): number | null {
  let x = target;
  for (let i = p.sources.length - 1; i >= 1; i--) {
    const s = p.sources[i];
    const m = s.cell.value;
    if (!Number.isFinite(m)) return null;
    if (s.op === '+') x -= m;
    else if (s.op === '*') {
      if (!m) return null;
      x /= m;
    } else return null;
  }
  return x;
}

export function readPowertrain(v: Vehicle): Powertrain {
  const out: Powertrain = { engines: [], gearboxes: [], finalDrives: [], wheelRadius: v.wheels.find((w) => w.hasTire)?.radius ?? v.wheels[0]?.radius ?? 0.32 };
  const devices: Array<{ type: string; name: string; row: any }> = [];
  for (const row of v.tables.get('powertrain') ?? []) {
    const type = String(row.v.type ?? ''), name = String(row.v.name ?? '');
    // a part installed twice lists its devices twice: once each
    if (type && name && !devices.some((d) => d.name === name)) devices.push({ type, name, row });
  }
  const prop = (s: PtSection, k: string) => s.props.find((p) => p.key === k) ?? null;
  for (const d of devices) {
    const sec = readSection(v, d.name);
    if (ENGINE.test(d.type) && sec?.luts.get('torque')) {
      const t = sec.luts.get('torque')!;
      const hdr = t.header ?? ['rpm', 'torque'];
      const ri = Math.max(0, hdr.indexOf('rpm')), ti = hdr.indexOf('torque') >= 0 ? hdr.indexOf('torque') : 1;
      const points = t.rows.filter((r) => r.cells.length >= 2).map((r) => ({ rpm: r.cells[ri], torque: r.cells[ti], row: r.row }));
      const sub = (key: string) => (typeof sec.data[key] === 'string' ? readSection(v, sec.data[key]) : null);
      out.engines.push({
        name: d.name, type: d.type, part: t.part, file: t.file, section: sec,
        turbo: sub('turbocharger'), supercharger: sub('supercharger'), nitrous: sub('nitrousOxideInjection'),
        points, table: t.arr,
        idleRPM: prop(sec, 'idleRPM'), maxRPM: prop(sec, 'maxRPM'), revLimiterRPM: prop(sec, 'revLimiterRPM'),
      });
    } else if (GEARBOX.test(d.type) && sec) {
      // gearRatios is a plain array: the last part that writes it
      let found: { arr: AArr; part: string; file: string } | null = null;
      for (const p of uniqueParts(v)) {
        const n = p.def.sections.get(d.name);
        const g = n && n.k === 'obj' ? objGet(n, 'gearRatios') : undefined;
        if (g && g.k === 'arr') found = { arr: g, part: p.def.name, file: p.def.file };
      }
      if (!found) continue;
      out.gearboxes.push({
        name: d.name, type: d.type, part: found.part, file: found.file,
        // values as the game reads them (an expression shows its result, locked)
        ratios: found.arr.items.map((x, i) => {
          const c = cellOf(x, v.vars, found!.file);
          const r = Array.isArray(sec.data.gearRatios) ? sec.data.gearRatios[i] : undefined;
          return Number.isFinite(c.value) || typeof r !== 'number' ? c : { ...c, value: r };
        }),
        array: found.arr, section: sec,
      });
    } else if (DRIVE.test(d.type)) {
      // final drive: in the device's section, else in the powertrain row's options
      const gp = sec ? prop(sec, 'gearRatio') : null;
      let ratio: PtCell | null = null, part = d.row.part.def.name, file = d.row.src.file;
      if (gp?.sources.length === 1) {
        ratio = { ...gp.sources[0].cell };
        part = gp.sources[0].part;
        file = gp.sources[0].file;
        if (!Number.isFinite(ratio.value) && typeof gp.value === 'number') ratio.value = gp.value;
      }
      if (!ratio) {
        const rowNode = d.row.src.node as ANode;
        const opts = rowNode.k === 'arr' ? rowNode.items.find((x) => x.k === 'obj') : undefined;
        const n = opts ? objGet(opts as AObj, 'gearRatio') : undefined;
        if (n) {
          ratio = cellOf(n, v.vars, file);
          if (!Number.isFinite(ratio.value) && typeof d.row.v.gearRatio === 'number') ratio.value = d.row.v.gearRatio;
        } else if (typeof d.row.v.gearRatio === 'number') ratio = { value: d.row.v.gearRatio, node: null };
      }
      if (ratio && Number.isFinite(ratio.value)) out.finalDrives.push({ name: d.name, type: d.type, part, file, ratio });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// curves, as the game computes them
// ---------------------------------------------------------------------------------------------

const RPM_TO_AV = Math.PI / 30;
const AV_TO_RPM = 30 / Math.PI;
const PSI_TO_PA = 6894.757;

/** ve_utils.lua createCurve: value per whole x (NaN where the game has nil). */
export function createCurve(points: Array<[number, number]>): Float64Array | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1][0];
  const res = new Float64Array(Math.max(0, Math.floor(last) + 1)).fill(NaN);
  const put = (x: number, y: number) => {
    if (x >= 0 && x < res.length) res[x] = y;
  };
  if (points.length === 2) {
    const [p1, p2] = points;
    const step = 1 / (p2[0] - p1[0]);
    let t = 0;
    for (let x = Math.floor(p1[0]); x <= Math.floor(p2[0]); x++) {
      put(x, p1[1] + t * (p2[1] - p1[1]));
      t += step;
    }
    return res;
  }
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(i + 2, n - 1)];
    const step = 1 / (p2[0] - p1[0]);
    let t = 0;
    const y0 = p0[1], y1 = p1[1], y2 = p2[1], y3 = p3[1];
    const c1 = 3 * (y1 - y2) + y3 - y0, c2 = 2 * y0 - 5 * y1 + 4 * y2 - y3, c3 = y2 - y0;
    for (let x = Math.floor(p1[0]); x <= Math.floor(p2[0]); x++) {
      put(x, y1 + 0.5 * t * (c3 + (c1 * t + c2) * t));
      t += step;
    }
  }
  return res;
}

/** tableFromHeaderTable: rows as {rpm, torque} (or the header's names) */
function lutPoints(t: unknown, xKey = 'rpm', yKey = 'torque'): Array<[number, number]> {
  if (!Array.isArray(t) || !t.length) return [];
  const head = Array.isArray(t[0]) && t[0].every((x: unknown) => typeof x === 'string') ? (t[0] as string[]) : null;
  const xi = head ? Math.max(0, head.indexOf(xKey)) : 0;
  const yi = head ? (head.indexOf(yKey) >= 0 ? head.indexOf(yKey) : 1) : 1;
  const out: Array<[number, number]> = [];
  for (const r of head ? t.slice(1) : t) {
    if (!Array.isArray(r)) continue;
    const x = Number(r[xi]), y = Number(r[yi]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

const at = (c: Float64Array | null, i: number) => (c && i >= 0 && i < c.length && !Number.isNaN(c[i]) ? c[i] : undefined);

export interface EngineCurves {
  /** the rpm the curves run to (the limiter when there is one) */
  maxRPM: number;
  /** the torque table alone (Catmull-Rom between its points) */
  table: Float64Array;
  /** torque table × torqueModMult + intake + exhaust, with the stall cut-off and redline drop-off */
  combined: Float64Array;
  /** combined − friction: what the game calls "NA" */
  na: Float64Array;
  /** with turbo / supercharger / nitrous: the game's final curve */
  final: Float64Array;
  /** boost coefficient per rpm (turbo × supercharger), 1 without forced induction */
  boostCoef: Float64Array | null;
  /** nitrous torque per rpm */
  nitrous: Float64Array | null;
  /** modifier curves as written (rpm → Nm or ×), for display */
  mods: { intake: Float64Array | null; exhaust: Float64Array | null; mult: Float64Array | null };
  hasTurbo: boolean;
  hasSupercharger: boolean;
}

/**
 * The torque curves of a combustion engine from its merged data and the merged data of its
 * turbocharger / supercharger / nitrous sections (null when not installed).
 */
export function engineCurves(eng: Record<string, any>, turbo: Record<string, any> | null, sc: Record<string, any> | null, n2o: Record<string, any> | null): EngineCurves | null {
  const basePts = lutPoints(eng.torque);
  if (basePts.length < 2) return null;
  let maxAvailable = 0;
  for (const p of basePts) maxAvailable = Math.max(maxAvailable, p[0]);
  const rawBase = createCurve(basePts);
  const mod = (t: unknown) => {
    const pts = lutPoints(t);
    for (const p of pts) maxAvailable = Math.max(maxAvailable, p[0]);
    return pts.length >= 2 ? createCurve(pts) : null;
  };
  const mult = eng.torqueModMult ? mod(eng.torqueModMult) : null;
  const intake = eng.torqueModIntake ? mod(eng.torqueModIntake) : null;
  const exhaust = eng.torqueModExhaust ? mod(eng.torqueModExhaust) : null;
  const lastOf = (c: Float64Array | null) => (c && c.length ? at(c, c.length - 1) ?? 0 : 0);
  const lastIntake = lastOf(intake), lastExhaust = lastOf(exhaust);
  // the compression brake table (a default one when missing) also stretches the available range
  const cb = lutPoints(eng.torqueCompressionBrake ?? [['rpm', 'torque'], [0, 0], [1000, 500], [3000, 1500]]);
  for (const p of cb) maxAvailable = Math.max(maxAvailable, p[0]);

  const raw = new Float64Array(Math.floor(maxAvailable) + 1);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = (at(rawBase, i) ?? 0) * (at(mult, i) ?? 1) + (intake ? at(intake, i) ?? lastIntake : 0) + (exhaust ? at(exhaust, i) ?? lastExhaust : 0);
  }
  const jbMax = Number(eng.maxRPM) || maxAvailable;
  let maxRPM = Math.min(jbMax, maxAvailable);
  const preRev = maxRPM;
  const hasRev = eng.hasRevLimiter === undefined ? true : !!eng.hasRevLimiter;
  if (hasRev) maxRPM = Number(eng.revLimiterRPM) || maxRPM;
  const idle = Number(eng.idleRPM) || 0;
  for (let i = 0; i <= idle * 0.3 && i < raw.length; i++) raw[i] = 0;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= preRev; i++) pts.push([i, i < raw.length ? raw[i] : 0]);
  const drop = Math.min(Math.max(Number(eng.redlineTorqueDropOffRange ?? 500), 10), preRev);
  const rawMax = Number.isInteger(preRev) && preRev < raw.length ? raw[preRev] : 0;
  pts.push([preRev + drop * 0.5, rawMax * 0.7], [preRev + drop, rawMax / 5], [preRev + drop * 2, 0]);
  if (preRev + drop * 2 < maxRPM) pts.push([maxRPM, 0]);
  const curve = createCurve(pts)!;

  const n = Math.max(0, Math.ceil(maxRPM));
  const friction = Number(eng.friction) || 0, dynFriction = Number(eng.dynamicFriction) || 0;
  const fr = (k: number) => friction + dynFriction * k * RPM_TO_AV;
  const table = new Float64Array(n).fill(NaN), combined = new Float64Array(n).fill(NaN), na = new Float64Array(n).fill(NaN), final = new Float64Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    table[k] = at(rawBase, k) ?? NaN;
    const c = at(curve, k);
    if (c === undefined) continue;
    combined[k] = c;
    na[k] = c - fr(k);
  }

  // turbocharger.getTorqueCoefs
  let turboCoef: Float64Array | null = null;
  if (turbo && Array.isArray(turbo.pressurePSI) && Array.isArray(turbo.engineDef)) {
    const pp = lutPoints(turbo.pressurePSI, 'turboRPM', 'psi');
    let maxTurboAV = 1;
    for (const p of pp) maxTurboAV = Math.max(maxTurboAV, p[0] * RPM_TO_AV);
    const pressure = createCurve(pp);
    const def = (turbo.engineDef as unknown[]).filter((r): r is number[] => Array.isArray(r) && r.every((x) => typeof x === 'number'));
    const exhaustCurve = createCurve(def.map((r) => [r[0], Math.min(r[2], 1)] as [number, number]));
    const effCurve = createCurve(def.map((r) => [r[0], r[1]] as [number, number]));
    // wastegate: per-gear tables or one value; the estimate uses the last entries
    const starts = (Array.isArray(turbo.wastegateStart) ? turbo.wastegateStart : [turbo.wastegateStart ?? 0]).map((x: unknown) => Number(x) * PSI_TO_PA);
    const limits: number[] = Array.isArray(turbo.wastegateLimit)
      ? turbo.wastegateLimit.map((x: unknown) => Number(x) * PSI_TO_PA)
      : typeof turbo.wastegateLimit === 'number' ? [turbo.wastegateLimit * PSI_TO_PA] : starts.map((s: number) => s + 0.01 * PSI_TO_PA);
    const maxStart = starts[starts.length - 1];
    const maxLimit = limits[limits.length - 1];
    const maxRange = (limits[starts.length - 1] ?? maxLimit) - maxStart;
    const wgLimitPsi = (maxStart + maxRange * 0.5) / PSI_TO_PA;
    const maxExhaustPower = turbo.maxExhaustPower ?? 1, backPressure = turbo.backPressureCoef ?? 0.0005, tFriction = turbo.frictionCoef ?? 0.01;
    const invEngMaxAV = 1 / ((maxRPM || 8000) * RPM_TO_AV);
    turboCoef = new Float64Array(n).fill(1);
    for (let k = 0; k < n; k++) {
      let av = Math.sqrt(Math.max(0.9 * k * RPM_TO_AV * invEngMaxAV * (at(exhaustCurve, k) ?? 1) * maxExhaustPower - tFriction, 0) / backPressure);
      av = Math.min(av, maxTurboAV);
      const p = at(pressure, Math.floor(av * AV_TO_RPM)) ?? 0;
      turboCoef[k] = 1 + 0.0000087 * Math.min(p, wgLimitPsi) * PSI_TO_PA * (at(effCurve, k) ?? 0);
    }
  }

  // supercharger.getTorqueCoefs
  let scCoef: Float64Array | null = null;
  if (sc && typeof sc.pressurePSIPer1kRPM === 'number') {
    const ratio = sc.gearRatio ?? 1;
    const maxBlower = Math.max(0, sc.maxRPM ?? Math.ceil(maxRPM * ratio));
    const crankLoss = (sc.crankLossPer1kRPM ?? 5) * 0.001;
    const engage = sc.clutchEngageRPM ?? 1000, invEngage = 1 / (sc.clutchEngageRange ?? engage * 0.2);
    const disengage = sc.clutchDisengageRPM ?? maxRPM * 2, invDisengage = 1 / (sc.clutchDisengageRange ?? disengage * 0.05);
    const type = String(sc.type ?? '').toLowerCase();
    const eff = type === 'screws' ? [0.3, 0, 0.7] : type === 'centrifugal' ? [0.6, 0, 0.45] : sc.twistedLobes ? [-0.35, 0, 1] : [-0.55, 0, 1];
    const perRpm = sc.pressurePSIPer1kRPM * 0.001;
    const pressure = new Float64Array(maxBlower + 1);
    for (let i = 0; i <= maxBlower; i++) {
      const rel = maxBlower ? i / maxBlower : 0;
      pressure[i] = Math.max((eff[0] * rel * rel + eff[1] * rel + eff[2]) * perRpm * i, 0);
    }
    scCoef = new Float64Array(n).fill(1);
    for (let k = 0; k < n; k++) {
      const clutch = Math.min(Math.min(Math.max((k - engage) * invEngage, 0), 1), Math.min(Math.max(-(k - disengage) * invDisengage + 1, 0), 1));
      const blower = k * ratio * clutch;
      const bi = Math.floor(blower);
      const p = bi >= 0 && bi <= maxBlower ? pressure[bi] : 0;
      scCoef[k] = 1 + 0.0000087 * p * PSI_TO_PA - crankLoss * blower;
    }
  }

  // nitrousOxideInjection.getAddedTorque
  let nitrous: Float64Array | null = null;
  if (n2o) {
    const added = (Number(n2o.addedPower) || 0) * 1000;
    const cutIn = Math.min(Math.max(Number(n2o.cutInRPM) || idle, 1), maxRPM * 0.9);
    const range = n2o.cutInRange ?? 50;
    nitrous = new Float64Array(n);
    for (let k = 1; k < n; k++) nitrous[k] = Math.min(Math.max((added * (k - (cutIn - range))) / range, 0), added) / (k * RPM_TO_AV);
  }

  let boostCoef: Float64Array | null = null;
  if (turboCoef || scCoef) {
    boostCoef = new Float64Array(n);
    for (let k = 0; k < n; k++) boostCoef[k] = (turboCoef ? turboCoef[k] : 1) * (scCoef ? scCoef[k] : 1);
  }
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(combined[k])) continue;
    final[k] = combined[k] * (boostCoef ? boostCoef[k] : 1) + (nitrous ? nitrous[k] : 0) - fr(k);
  }
  return { maxRPM, table, combined, na, final, boostCoef, nitrous, mods: { intake, exhaust, mult }, hasTurbo: !!turboCoef, hasSupercharger: !!scCoef };
}

/** peak of a curve: [value, rpm] */
export function peak(c: Float64Array, f: (v: number, rpm: number) => number = (v) => v): [number, number] {
  let best = -Infinity, at = 0;
  for (let k = 0; k < c.length; k++) {
    if (Number.isNaN(c[k])) continue;
    const x = f(c[k], k);
    if (x > best) {
      best = x;
      at = k;
    }
  }
  return [best === -Infinity ? 0 : best, at];
}

/** kW from torque (Nm) and rpm */
export const kW = (torque: number, rpm: number) => (torque * rpm) / 9549;
/** metric horsepower from kW */
export const PS = (kw: number) => kw * 1.35962;
/** mechanical horsepower from kW */
export const HP = (kw: number) => kw * 1.34102;

/**
 * Road speed (km/h) at an engine rpm through a gear and the final drive(s), for a wheel radius in
 * metres.
 */
export function roadSpeed(rpm: number, gear: number, finalDrive: number, radius: number): number {
  if (!gear || !finalDrive) return 0;
  return ((rpm / (Math.abs(gear) * finalDrive)) * 2 * Math.PI * radius * 60) / 1000;
}

// ---------------------------------------------------------------------------------------------
// layers: the parts of the curve, each written in one part
// ---------------------------------------------------------------------------------------------

/** The data the curves are computed from (merged sections of one configuration). */
export interface PtData {
  eng: Record<string, any>;
  turbo: Record<string, any> | null;
  sc: Record<string, any> | null;
  n2o: Record<string, any> | null;
}

export type PtSectionKind = 'eng' | 'turbo' | 'sc' | 'n2o';

export interface PtLayer {
  id: string;
  label: string;
  section: PtSectionKind;
  /** key in the section */
  key: string;
  /** a table layer: its rows; yCol is the column it changes */
  lut?: PtLut;
  yCol: number;
  /** a single-value layer (supercharger pressure per rpm, nitrous power) */
  prop?: PtProp;
  part: string;
  file: string;
  /** unit of the values */
  unit: string;
  xUnit: string;
}

/** The merged engine data of a vehicle (any configuration), for the curves. */
export function ptData(v: Vehicle, engine = 'mainEngine'): PtData | null {
  const eng = v.dicts.get(engine);
  if (!eng) return null;
  const sub = (k: string) => (typeof eng[k] === 'string' ? v.dicts.get(eng[k]) ?? null : null);
  return { eng, turbo: sub('turbocharger'), sc: sub('supercharger'), n2o: sub('nitrousOxideInjection') };
}

export function curvesOf(d: PtData | null): EngineCurves | null {
  return d ? engineCurves(d.eng, d.turbo, d.sc, d.n2o) : null;
}

/** What shapes the torque of an engine, layer by layer. */
export function engineLayers(e: PtEngine): PtLayer[] {
  const out: PtLayer[] = [];
  const lut = (sec: PtSection | null, kind: PtSectionKind, key: string, label: string, unit: string, yCol = 1, xUnit = 'rpm', id = key) => {
    const l = sec?.luts.get(key);
    if (l) out.push({ id, label, section: kind, key, lut: l, yCol, part: l.part, file: l.file, unit, xUnit });
  };
  const scalar = (sec: PtSection | null, kind: PtSectionKind, key: string, label: string, unit: string) => {
    const p = sec?.props.find((x) => x.key === key);
    const src = p?.sources[0];
    if (p && src) out.push({ id: kind + '.' + key, label, section: kind, key, prop: p, yCol: 0, part: src.part, file: src.file, unit, xUnit: '' });
  };
  lut(e.section, 'eng', 'torque', 'Torque table', 'Nm');
  lut(e.section, 'eng', 'torqueModMult', 'Multiplier', '×');
  lut(e.section, 'eng', 'torqueModIntake', 'Intake', 'Nm');
  lut(e.section, 'eng', 'torqueModExhaust', 'Exhaust', 'Nm');
  lut(e.turbo, 'turbo', 'pressurePSI', 'Turbo pressure', 'psi', 1, 'turbine rpm', 'turbo.pressurePSI');
  lut(e.turbo, 'turbo', 'engineDef', 'Turbo efficiency', '', 1, 'rpm', 'turbo.engineDef.1');
  scalar(e.supercharger, 'sc', 'pressurePSIPer1kRPM', 'Supercharger boost', 'psi/1k rpm');
  scalar(e.nitrous, 'n2o', 'addedPower', 'Nitrous', 'kW');
  return out;
}

/** A change to a layer: one point moved, or the whole layer scaled. */
export type LayerEdit = { kind: 'point'; i: number; x: number; y: number } | { kind: 'scale'; f: number };

const secOf = (d: PtData, k: PtSectionKind) => (k === 'eng' ? d.eng : k === 'turbo' ? d.turbo : k === 'sc' ? d.sc : d.n2o);

/** The value of a layer in a configuration's data. */
export function layerValue(d: PtData, layer: PtLayer): unknown {
  return secOf(d, layer.section)?.[layer.key];
}

/**
 * The data with a layer edited. `original` is the layer's value in the configuration the edit was
 * made in: another configuration only changes where it has that same value (the same part).
 */
export function withLayerEdit(d: PtData, layer: PtLayer, edit: LayerEdit, original?: unknown): PtData {
  const sec = secOf(d, layer.section);
  if (!sec) return d;
  const cur = sec[layer.key];
  if (original !== undefined && JSON.stringify(cur) !== JSON.stringify(original)) return d;
  let next: unknown;
  if (layer.prop) {
    if (typeof cur !== 'number') return d;
    next = edit.kind === 'scale' ? cur * edit.f : cur;
  } else {
    if (!Array.isArray(cur)) return d;
    const off = layer.lut?.header ? 1 : 0;
    next = cur.map((r: unknown, ri: number) => {
      if (!Array.isArray(r) || ri < off) return r;
      const row = [...r];
      if (edit.kind === 'scale') {
        if (typeof row[layer.yCol] === 'number') row[layer.yCol] *= edit.f;
      } else if (ri - off === edit.i) {
        row[0] = edit.x;
        row[layer.yCol] = edit.y;
      }
      return row;
    });
  }
  const s2 = { ...sec, [layer.key]: next };
  return layer.section === 'eng' ? { ...d, eng: s2 } : layer.section === 'turbo' ? { ...d, turbo: s2 } : layer.section === 'sc' ? { ...d, sc: s2 } : { ...d, n2o: s2 };
}

/**
 * The factor to scale a layer by so that the peak (of torque, or of `metric`) reaches `target`,
 * or null when the layer can't get there (between ×0 and ×10).
 */
export function solveLayerScale(d: PtData, layer: PtLayer, target: number, metric: (t: number, rpm: number) => number = (t) => t): number | null {
  const f = (s: number) => {
    const c = curvesOf(withLayerEdit(d, layer, { kind: 'scale', f: s }));
    return c ? peak(c.final, metric)[0] : NaN;
  };
  let lo = 0, hi = 10;
  const flo = f(lo), fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  const up = fhi > flo;
  if ((up && (target < flo || target > fhi)) || (!up && (target > flo || target < fhi))) return null;
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if ((fm < target) === up) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
