/**
 * Vehicle assembly: a faithful port of BeamNG's jbeam loading pipeline
 * (lua/common/jbeam: io, slotSystem, variables, tableSchema, sectionMerger, nodeBeam),
 * with one addition the game does not need: every produced element remembers the
 * exact source row it came from, so the editor can navigate and edit the text.
 */
import type { ANode, AObj } from '../sjson';
import { evalExpression, type Scope } from './expr';
import { applyNodeXform, flexbodyXform, getNodeXform } from './nodeTransform';

/** 0.40 occupant parts (occupant_generic & co, plugged into seat_occupant slots) */
export function isOccupant(p: ActivePart): boolean {
  return p.def.slotTypes.includes('seat_occupant') || /occupant/i.test(p.def.name);
}
import type {
  ActivePart, BeamType, Issue, JFile, PartDef, Row, SlotDef, SlotNode, SrcRef, VarDef, Vehicle,
  VehicleConfig, VBeam, VFlexbody, VNode, VProp, VTri, VWheel,
} from './types';

// ---------------------------------------------------------------------------------------------
// Part library
// ---------------------------------------------------------------------------------------------

export class PartLibrary {
  private byName = new Map<string, PartDef>();
  private bySlot = new Map<string, PartDef[]>();
  readonly duplicates: Array<{ name: string; files: string[] }> = [];
  mainPart: string | undefined;

  /** @param groups directories in priority order (vehicle folder first, then common) */
  constructor(readonly groups: JFile[][]) {
    for (const group of groups) {
      const local = new Map<string, PartDef>();
      for (const file of group) {
        for (const part of file.parts) {
          if (part.slotTypes.length === 0) continue; // the game ignores parts without slotType
          const prev = local.get(part.name);
          if (prev) this.duplicates.push({ name: part.name, files: [prev.file, part.file] });
          local.set(part.name, part);
        }
      }
      for (const part of local.values()) {
        if (this.byName.has(part.name)) continue; // earlier directory wins
        this.byName.set(part.name, part);
        for (const st of part.slotTypes) {
          let list = this.bySlot.get(st);
          if (!list) this.bySlot.set(st, (list = []));
          list.push(part);
        }
      }
      if (!this.mainPart) {
        for (const part of local.values()) {
          if (part.slotTypes.includes('main')) {
            this.mainPart = part.name;
            break;
          }
        }
      }
    }
  }

  get(name: string | undefined): PartDef | undefined {
    return name ? this.byName.get(name) : undefined;
  }

  forSlotType(type: string): PartDef[] {
    return this.bySlot.get(type) ?? [];
  }

  /** Parts that can be installed in a slot (allow list minus deny list). */
  compatible(slot: SlotDef): PartDef[] {
    const out: PartDef[] = [];
    const seen = new Set<string>();
    for (const t of slot.allowTypes) {
      for (const p of this.forSlotType(t)) {
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        if (slot.denyTypes.length && p.slotTypes.some((x) => slot.denyTypes.includes(x))) continue;
        out.push(p);
      }
    }
    return out;
  }

  all(): IterableIterator<PartDef> {
    return this.byName.values();
  }

  get size(): number {
    return this.byName.size;
  }
}

export function partFitsSlot(part: PartDef, slot: SlotDef): boolean {
  if (!part.slotTypes.some((t) => slot.allowTypes.includes(t))) return false;
  if (part.slotTypes.some((t) => slot.denyTypes.includes(t))) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------------------------

interface EvalCtx {
  issues: Issue[];
  file?: string;
  part?: string;
}

const SPECIAL: Record<string, number> = { FLT_MAX: Infinity, MINUS_FLT_MAX: -Infinity };

function resolveString(s: string, scope: Scope, ctx: EvalCtx, node?: ANode, exprOnly = false): any {
  if (s.charCodeAt(0) !== 36 /* $ */) {
    const sp = SPECIAL[s];
    return sp !== undefined ? sp : s;
  }
  const c = s.charCodeAt(1);
  if (c === 61 /* = */) {
    try {
      const v = evalExpression(s, scope);
      return v === null ? undefined : v;
    } catch (e: any) {
      ctx.issues.push({
        sev: 'error', code: 'expr', msg: `Expression failed: ${s} — ${e?.message ?? e}`,
        file: ctx.file, part: ctx.part, s: node?.s, e: node?.e,
      });
      return undefined;
    }
  }
  if (exprOnly) return s;
  if (c === 62 && s.charCodeAt(2) === 62) return undefined; // $>> component redirect: not evaluated here
  if (c === 46 /* . */) return (scope['$prefix'] ?? '') + s.slice(2) + (scope['$suffix'] ?? '');
  if (c === 43 || c === 60 || c === 62) return s; // $+ $< $> merge indicators
  const v = scope[s];
  if (v === undefined) {
    ctx.issues.push({
      sev: 'error', code: 'missing-variable', msg: `Missing variable ${s}`,
      file: ctx.file, part: ctx.part, s: node?.s, e: node?.e,
    });
    return undefined;
  }
  return v;
}

function evalNode(node: ANode, scope: Scope, ctx: EvalCtx, exprOnly = false): any {
  switch (node.k) {
    case 'num':
    case 'bool':
      return node.v;
    case 'str':
      return resolveString(node.v, scope, ctx, node, exprOnly);
    case 'arr': {
      const out = new Array(node.items.length);
      for (let i = 0; i < out.length; i++) out[i] = evalNode(node.items[i], scope, ctx, exprOnly);
      return out;
    }
    case 'obj': {
      const out: Record<string, any> = {};
      for (let i = 0; i < node.keys.length; i++) {
        let key = node.keys[i].v;
        if (key.charCodeAt(0) === 36 && !exprOnly) {
          const c = key.charCodeAt(1);
          if (c !== 43 && c !== 60 && c !== 62 && c !== 42) {
            const nk = resolveString(key, scope, ctx, node.keys[i]);
            if (typeof nk === 'string' || typeof nk === 'number') key = String(nk);
          }
        }
        if (key === '__proto__') continue;
        out[key] = evalNode(node.vals[i], scope, ctx, exprOnly);
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** Resolves variables inside an already-plain JS value (used for slot options). */
function resolveValue(v: any, scope: Scope, ctx: EvalCtx): any {
  if (typeof v === 'string') return resolveString(v, scope, ctx);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, scope, ctx));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k in v) out[k] = resolveValue(v[k], scope, ctx);
    return out;
  }
  return v;
}

/** variables.lua applySlotVars: resolves slot-scope variables repeatedly against the parent scope. */
function applySlotVars(slotVars: Record<string, any> | undefined, parent: Scope, ctx: EvalCtx): Scope {
  if (!slotVars) return {};
  const pending: Record<string, any> = { ...slotVars };
  const vars: Scope = { ...parent };
  const done: Scope = {};
  for (let iter = 0; iter < 400; iter++) {
    let passed = false;
    for (const k of Object.keys(pending)) {
      const v = pending[k];
      if (typeof v === 'string' && v.charCodeAt(0) === 36) {
        const c = v.charCodeAt(1);
        if (c === 61) {
          try {
            const res = evalExpression(v, vars);
            passed = true;
            done[k] = res;
            vars[k] = res;
            delete pending[k];
          } catch {
            /* retry on next pass, it may depend on another slot variable */
          }
        } else if (c !== 43 && c !== 60 && c !== 62) {
          passed = true;
          delete pending[k];
          if (vars[v] !== undefined) {
            done[k] = vars[v];
            vars[k] = vars[v];
          }
        }
      } else {
        passed = true;
        done[k] = v;
        vars[k] = v;
        delete pending[k];
      }
    }
    if (!passed) break;
  }
  for (const k of Object.keys(pending)) {
    ctx.issues.push({ sev: 'warning', code: 'slot-var', msg: `Slot variable ${k} could not be resolved (${pending[k]})`, file: ctx.file, part: ctx.part });
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// Slot tree
// ---------------------------------------------------------------------------------------------

export interface ResolveResult {
  root: ActivePart | null;
  parts: ActivePart[];
  issues: Issue[];
}

function configChoice(config: VehicleConfig, treeNode: any, slotId: string, path: string): { choice: string | undefined; next: any } {
  if (config.parts) {
    let want = config.parts[slotId];
    if (want === undefined) want = config.parts[path];
    if (want === 'none') want = '';
    return { choice: want, next: undefined };
  }
  if (treeNode && treeNode.children && treeNode.children[slotId]) {
    const child = treeNode.children[slotId];
    let want = child.chosenPartName;
    if (want === 'none') want = '';
    return { choice: want, next: child };
  }
  return { choice: undefined, next: undefined };
}

export function resolveTree(lib: PartLibrary, config: VehicleConfig): ResolveResult {
  const issues: Issue[] = [];
  const mainName = config.mainPartName ?? lib.mainPart;
  const rootDef = lib.get(mainName);
  if (!rootDef) {
    issues.push({ sev: 'error', code: 'no-main', msg: mainName ? `Main part "${mainName}" not found` : 'No part with slotType "main" found' });
    return { root: null, parts: [], issues };
  }
  const parts: ActivePart[] = [];
  const root: ActivePart = { def: rootDef, path: '/' + rootDef.name, level: 0, slotOptions: {}, scope: {}, slots: [], order: 0 };
  parts.push(root);
  const recursion = new Map<string, number>();

  const fill = (owner: ActivePart, rawOpts: Record<string, any>, path: string, treeNode: any) => {
    if (owner.level > 50) {
      issues.push({ sev: 'error', code: 'slot-cycle', msg: 'More than 50 slot levels — check for cycles', part: owner.def.name, file: owner.def.file });
      return;
    }
    for (const slot of owner.def.slots) {
      const slotId = slot.name;
      const level = (recursion.get(slotId) ?? 0) + 1;
      if (typeof slot.maxRecursion === 'number' && level > slot.maxRecursion) continue;
      const newPath = path + slotId + '/';
      const { choice, next } = configChoice(config, treeNode, slotId, newPath);
      const sn: SlotNode = { id: slotId, path: newPath, def: slot, owner, chosen: '', decision: 'empty', wanted: choice };
      owner.slots.push(sn);
      if (choice === '') {
        sn.decision = 'user-empty';
        continue;
      }
      let def: PartDef | undefined;
      if (choice) {
        def = lib.get(choice);
        if (def) {
          if (!partFitsSlot(def, slot)) {
            issues.push({
              sev: 'error', code: 'slot-type',
              msg: `Part "${choice}" does not fit slot "${slotId}" (slotType ${JSON.stringify(def.slotTypes)}, allowed ${JSON.stringify(slot.allowTypes)}). Reset to default.`,
              file: owner.def.file, s: slot.row?.s, e: slot.row?.e, part: owner.def.name,
            });
            def = undefined;
          } else {
            sn.decision = 'user';
          }
        } else {
          issues.push({
            sev: 'warning', code: 'part-missing',
            msg: `Slot "${slotId}": wanted part "${choice}" was not found`, file: owner.def.file, s: slot.row?.s, e: slot.row?.e, part: owner.def.name,
          });
          sn.decision = 'missing';
        }
      }
      if (!def && slot.default !== undefined) {
        if (slot.default === '') {
          sn.decision = 'default-empty';
          continue;
        }
        def = lib.get(slot.default);
        if (def) {
          sn.decision = 'default';
        } else {
          issues.push({
            sev: 'info', code: 'default-missing',
            msg: `Slot "${slotId}": default part "${slot.default}" was not found`, file: owner.def.file, s: slot.row?.s, e: slot.row?.e, part: owner.def.name,
          });
        }
      }
      if (!def) continue;
      const opts = { ...rawOpts, ...slot.options };
      const part: ActivePart = {
        def, path: newPath + def.name, level: owner.level + 1, parent: owner, slot: sn,
        slotOptions: opts, scope: {}, slots: [], order: parts.length,
      };
      sn.chosen = def.name;
      sn.part = part;
      parts.push(part);
      if (def.slots.length) {
        const prev = recursion.get(slotId);
        recursion.set(slotId, level);
        fill(part, opts, newPath, next);
        if (prev === undefined) recursion.delete(slotId);
        else recursion.set(slotId, prev);
      }
    }
  };
  fill(root, {}, '/', (config as any).partsTree);
  return { root, parts, issues };
}

/** Treats the given parts as independent roots (single-file preview without slot resolution). */
export function looseParts(defs: PartDef[]): ActivePart[] {
  return defs.map((def, i) => ({ def, path: '/' + def.name, level: 0, slotOptions: {}, scope: {}, slots: [], order: i }));
}

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

const SKIP_SECTIONS = new Set(['slots', 'slots2', 'information', 'slotType', 'variables', 'components', 'partName']);

function readVariables(part: ActivePart, scope: Scope, userVars: Record<string, number>, ctx: EvalCtx): VarDef[] {
  const table = part.def.sections.get('variables');
  const out: VarDef[] = [];
  if (!table || table.k !== 'arr' || table.items.length < 2) return out;
  const h = table.items[0];
  if (h.k !== 'arr') return out;
  const header = h.items.map((x) => (x.k === 'str' ? x.v : ''));
  let local: Record<string, any> = {};
  for (let r = 1; r < table.items.length; r++) {
    const row = table.items[r];
    if (row.k === 'obj') {
      Object.assign(local, evalNode(row, scope, ctx, true));
      continue;
    }
    if (row.k !== 'arr') continue;
    const v: Record<string, any> = { ...local };
    for (let c = 0; c < row.items.length; c++) {
      const cell = row.items[c];
      if (c >= header.length) {
        if (cell.k === 'obj') Object.assign(v, evalNode(cell, scope, ctx, true));
        continue;
      }
      v[header[c]] = evalNode(cell, scope, ctx, true);
    }
    if (typeof v.name !== 'string') continue;
    if (v.type !== 'range') {
      ctx.issues.push({ sev: 'warning', code: 'var-type', msg: `Variable ${v.name} ignored, unknown type "${v.type}"`, file: part.def.file, s: row.s, e: row.e, part: part.def.name });
      continue;
    }
    if (typeof v.min !== 'number' || typeof v.max !== 'number' || typeof v.default !== 'number') {
      ctx.issues.push({ sev: 'error', code: 'var-number', msg: `Variable ${v.name} ignored: default/min/max must be numbers`, file: part.def.file, s: row.s, e: row.e, part: part.def.name });
      continue;
    }
    let val = typeof userVars[v.name] === 'number' ? userVars[v.name] : v.default;
    val = Math.min(Math.max(val, Math.min(v.min, v.max)), Math.max(v.min, v.max));
    out.push({
      name: v.name, type: v.type, unit: v.unit || undefined, category: v.category || undefined, default: v.default,
      min: v.min, max: v.max, title: v.title, description: v.description, val,
      part: part.def.name, file: part.def.file, row,
    });
  }
  return out;
}

function resolveScopes(parts: ActivePart[], config: VehicleConfig, issues: Issue[], loose: boolean): { variables: VarDef[]; vars: Scope } {
  const userVars = config.vars ?? {};
  const silent: EvalCtx = { issues: [] };
  const byName = new Map<string, VarDef>();
  // pass 1: collect all variables, evaluating each part's list inside its slot scope
  const scope1 = new Map<ActivePart, Scope>();
  for (const part of parts) {
    const ctx: EvalCtx = { issues, file: part.def.file, part: part.def.name };
    let scope: Scope;
    if (part.parent) {
      const parent = scope1.get(part.parent) ?? {};
      scope = { ...parent, ...applySlotVars(part.slot?.def.variables, parent, silent) };
    } else {
      scope = {};
    }
    const defs = readVariables(part, scope, userVars, ctx);
    if (defs.length) {
      scope = { ...scope };
      for (const d of defs) {
        scope[d.name] = d.val;
        byName.set(d.name, d);
      }
    }
    scope1.set(part, scope);
  }
  const vars: Scope = {};
  for (const d of byName.values()) vars[d.name] = d.val;
  // components (variables.lua processComponents): merged across parts, readable as $components.a.b
  const components: Record<string, any> = {};
  for (const part of parts) {
    const node = part.def.sections.get('components');
    if (!node || node.k !== 'obj') continue;
    const val = evalNode(node, { ...(scope1.get(part) ?? {}), ...vars }, silent) as Record<string, any>;
    for (const k in val) {
      if (isDict(val[k])) components[k] = mergeDeep(isDict(components[k]) ? components[k] : {}, val[k]);
      else components[k] = val[k];
    }
  }
  vars['$components'] = components;
  // pass 2: final scopes = all variables + slot variables down the chain
  for (const part of parts) {
    const ctx: EvalCtx = { issues, file: part.def.file, part: part.def.name };
    if (part.parent) {
      const parent = part.parent.scope;
      const sv = applySlotVars(part.slot?.def.variables, parent, ctx);
      part.scope = Object.keys(sv).length ? { ...parent, ...sv } : parent;
    } else {
      part.scope = vars;
    }
    if (part.parent || loose) {
      const raw = part.slotOptions;
      const resolved = resolveValue(raw, part.scope, ctx);
      delete resolved.coreSlot;
      delete resolved.variables;
      part.slotOptions = resolved;
    }
  }
  return { variables: [...byName.values()], vars };
}

// ---------------------------------------------------------------------------------------------
// Table processing (tableSchema.lua)
// ---------------------------------------------------------------------------------------------

const BEAM_TYPES: BeamType[] = ['NORMAL', 'HYDRO', 'ANISOTROPIC', 'BOUNDED', 'PRESSURED', 'SUPPORT', 'LBEAM', 'BROKEN'];

export function beamTypeOf(v: any, fallback: BeamType = 'NORMAL'): BeamType {
  if (typeof v !== 'string' || v.charCodeAt(0) !== 124) return fallback;
  for (const seg of v.split('|')) {
    if (seg === 'TIRESIDE') return 'ANISOTROPIC';
    if ((BEAM_TYPES as string[]).includes(seg)) return seg as BeamType;
  }
  return fallback;
}

function isDict(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergeDeep(dst: Record<string, any>, src: Record<string, any>): Record<string, any> {
  for (const k in src) {
    const v = src[k];
    if (isDict(v) && isDict(dst[k])) mergeDeep(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

interface TableBuild {
  header: string[] | null;
  headerPart?: ActivePart;
  rows: Row[];
  local: Record<string, any>;
  count: number;
}

function emitPartRows(tb: TableBuild, part: ActivePart, section: string, table: ANode, issues: Issue[]): void {
  if (table.k !== 'arr') return;
  const items = table.items;
  if (items.length === 0) return;
  const ctx: EvalCtx = { issues, file: part.def.file, part: part.def.name };
  // The first row of every part's table is its header. The first contributing part defines the columns.
  const h = items[0];
  if (tb.header === null) {
    if (h.k !== 'arr') {
      issues.push({ sev: 'error', code: 'table-header', msg: `Section "${section}": first row must be the table header`, file: part.def.file, s: h.s, e: h.e, part: part.def.name });
      tb.header = [];
    } else {
      tb.header = h.items.map((x) => (x.k === 'str' ? x.v : String((x as any).v ?? '')));
    }
    tb.headerPart = part;
  } else if (h.k === 'arr' && tb.header.length) {
    const hh = h.items.map((x) => (x.k === 'str' ? x.v : ''));
    if (hh.length !== tb.header.length || hh.some((x, i) => x !== tb.header![i])) {
      // only a problem when it really looks like a header (all strings) but differs
      if (h.items.every((x) => x.k === 'str') && hh[0] === tb.header[0]) {
        issues.push({
          sev: 'warning', code: 'header-mismatch',
          msg: `Section "${section}" header differs from the one in part "${tb.headerPart?.def.name}" which the game will use: ${JSON.stringify(tb.header)}`,
          file: part.def.file, s: h.s, e: h.e, part: part.def.name,
        });
      }
    }
  }
  const header = tb.header;
  const hlen = header.length;
  for (let r = 1; r < items.length; r++) {
    const row = items[r];
    if (row.k === 'obj') {
      const o = evalNode(row, part.scope, ctx);
      tb.local = Object.assign({}, tb.local, o);
      continue;
    }
    if (row.k !== 'arr') {
      issues.push({ sev: 'warning', code: 'table-row', msg: `Section "${section}": invalid table row`, file: part.def.file, s: row.s, e: row.e, part: part.def.name });
      continue;
    }
    const cells = row.items;
    if (cells.length > hlen + 1) {
      issues.push({
        sev: 'warning', code: 'row-too-long',
        msg: `Section "${section}": row has ${cells.length} cells but the header has ${hlen} columns (+1 for options). The game discards this row.`,
        file: part.def.file, s: row.s, e: row.e, part: part.def.name,
      });
      continue;
    }
    const v: Record<string, any> = Object.assign({}, tb.local);
    let n = cells.length;
    // inline options: a dict in the extra cell right after the last header column
    if (n === hlen + 1) {
      const last = cells[n - 1];
      if (last.k === 'obj') Object.assign(v, evalNode(last, part.scope, ctx));
      n = hlen;
    }
    if (v.disable === true || (isDict(v.variables) && v.variables.disable === true)) continue;
    for (let c = 0; c < n; c++) {
      const key = header[c];
      if (key === undefined) continue;
      v[key] = evalNode(cells[c], part.scope, ctx);
    }
    tb.rows.push({ v, src: { file: part.def.file, part: part.def.name, section, node: row, table }, part });
    tb.count++;
  }
}

// ---------------------------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------------------------

const WHEEL_SECTIONS = ['wheels', 'monoHubWheels', 'hubWheelsTSV', 'hubWheelsTSI', 'hubWheels', 'pressureWheels'];

function numOr(v: any, d: number): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : d;
}

function xyz(v: any): [number, number, number] | null {
  if (!isDict(v)) return null;
  return [numOr(v.x, 0), numOr(v.y, 0), numOr(v.z, 0)];
}

function groupsOf(v: any): string[] {
  if (typeof v === 'string') return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  return [];
}

export interface BuildOptions {
  /** Loose mode: parts are shown side by side without slot resolution; missing node links are expected. */
  loose?: boolean;
}

export function buildVehicle(parts: ActivePart[], config: VehicleConfig, baseIssues: Issue[] = [], opts: BuildOptions = {}): Vehicle {
  const issues: Issue[] = [...baseIssues];
  const loose = !!opts.loose;
  const root = parts[0];
  const { variables, vars } = resolveScopes(parts, config, issues, loose);

  // --- merge sections in unify order (pre-order, slot options bracket each part and its children)
  const tables = new Map<string, TableBuild>();
  const dicts = new Map<string, Record<string, any>>();
  const options: Record<string, any> = {};

  const tableFor = (name: string): TableBuild => {
    let tb = tables.get(name);
    if (!tb) tables.set(name, (tb = { header: null, rows: [], local: {}, count: 0 }));
    return tb;
  };

  // which sections does the subtree of each part touch? needed to place the slot-option brackets
  const subtreeSections = new Map<ActivePart, Set<string>>();
  const childrenOf = new Map<ActivePart, ActivePart[]>();
  for (const p of parts) {
    if (p.parent) {
      let list = childrenOf.get(p.parent);
      if (!list) childrenOf.set(p.parent, (list = []));
      list.push(p);
    }
  }
  const collect = (p: ActivePart): Set<string> => {
    const set = new Set<string>();
    for (const [name, node] of p.def.sections) {
      if (node.k === 'arr' && node.items.length && !SKIP_SECTIONS.has(name)) set.add(name);
    }
    for (const c of childrenOf.get(p) ?? []) for (const s of collect(c)) set.add(s);
    subtreeSections.set(p, set);
    return set;
  };
  const roots = parts.filter((p) => !p.parent);
  for (const r of roots) collect(r);

  const emit = (part: ActivePart): void => {
    const ctx: EvalCtx = { issues, file: part.def.file, part: part.def.name };
    const isRoot = !part.parent && !loose;
    const slotOpts: Record<string, any> = isRoot ? {} : { ...part.slotOptions, partOrigin: part.def.name, partPath: part.path };
    const touched = subtreeSections.get(part)!;
    if (!isRoot) {
      for (const name of touched) {
        const tb = tableFor(name);
        tb.local = Object.assign({}, tb.local, slotOpts);
      }
    }
    for (const [name, node] of part.def.sections) {
      if (SKIP_SECTIONS.has(name)) continue;
      if (node.k === 'arr') {
        if (node.items.length === 0) continue;
        emitPartRows(tableFor(name), part, name, node, issues);
      } else if (node.k === 'obj') {
        let target = dicts.get(name);
        if (!target) dicts.set(name, (target = {}));
        const src = evalNode(node, part.scope, ctx) as Record<string, any>;
        for (const k in src) {
          const val = src[k];
          if (typeof val === 'number' && k.charCodeAt(0) === 36) {
            const actual = k.slice(2);
            const existingMod = target[k];
            let existing = target[actual];
            let destKey = actual;
            if (typeof existingMod === 'number') {
              existing = existingMod;
              destKey = k;
            }
            if (typeof existing === 'number') {
              const c = k.charCodeAt(1);
              if (c === 43) target[destKey] = existing + val;
              else if (c === 42) target[destKey] = existing * val;
              else if (c === 60) target[destKey] = Math.min(existing, val);
              else if (c === 62) target[destKey] = Math.max(existing, val);
              else target[k] = val;
            } else {
              target[k] = val;
            }
          } else {
            target[k] = val;
          }
        }
      } else if (name !== 'slotType') {
        options[name] = evalNode(node, part.scope, ctx);
      }
    }
    for (const c of childrenOf.get(part) ?? []) emit(c);
    if (!isRoot) {
      const reset: Record<string, any> = {};
      for (const k in slotOpts) reset[k] = '';
      for (const name of touched) {
        const tb = tableFor(name);
        tb.local = Object.assign({}, tb.local, reset);
      }
    }
  };
  // vehicle.options (top-level scalars of all parts) seed every table's modifiers, so they must be
  // known before rows are processed: collect them first.
  for (const p of parts) {
    const ctx: EvalCtx = { issues: [], file: p.def.file, part: p.def.name };
    for (const [name, node] of p.def.sections) {
      if (node.k !== 'arr' && node.k !== 'obj' && name !== 'slotType' && !SKIP_SECTIONS.has(name)) {
        options[name] = evalNode(node, p.scope, ctx);
      }
    }
  }
  if (root && !loose) {
    options.partOrigin = root.def.name;
    options.partPath = root.path;
  }
  // pre-seed tables so that `local` starts from the vehicle options
  const seed = (name: string) => {
    const tb = tableFor(name);
    tb.local = Object.assign({}, options);
  };
  for (const r of roots) for (const s of subtreeSections.get(r)!) if (!tables.has(s)) seed(s);
  for (const r of roots) emit(r);

  const tableRows = new Map<string, Row[]>();
  const headers = new Map<string, string[]>();
  for (const [name, tb] of tables) {
    tableRows.set(name, tb.rows);
    headers.set(name, tb.header ?? []);
  }
  // sectionMerger: triggers2 -> triggers, rails2 -> rails (kept separately too; consumers read both)

  // --- nodes
  const nodes: VNode[] = [];
  const nodeIndex = new Map<string, number>();
  const nodeHeader = headers.get('nodes') ?? [];
  const cx = nodeHeader.indexOf('posX'), cy = nodeHeader.indexOf('posY'), cz = nodeHeader.indexOf('posZ');
  for (const row of tableRows.get('nodes') ?? []) {
    const v = row.v;
    if (v.id === undefined || v.id === null) continue;
    const name = String(v.id);
    const px = Number(v.posX), py = Number(v.posY), pz = Number(v.posZ);
    if (Number.isNaN(px) || Number.isNaN(py) || Number.isNaN(pz)) {
      issues.push({ sev: 'error', code: 'node-pos', msg: `Node "${name}" has an invalid position`, file: row.src.file, s: row.src.node.s, e: row.src.node.e, part: row.src.part });
      continue;
    }
    const xf = getNodeXform(v);
    const p = applyNodeXform(xf, px, py, pz);
    const cells = (row.src.node as any).items as ANode[];
    const raw: [number, number, number] | null =
      cells[cx]?.k === 'num' && cells[cy]?.k === 'num' && cells[cz]?.k === 'num' ? [px, py, pz] : null;
    const existing = nodeIndex.get(name);
    const node: VNode = { name, idx: existing ?? nodes.length, x: p.x, y: p.y, z: p.z, raw, row, groups: groupsOf(v.group) };
    if (existing !== undefined) {
      const prev = nodes[existing];
      const samePart = prev.row.src.part === row.src.part && prev.row.src.file === row.src.file;
      const moved = Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) + Math.abs(prev.z - p.z) > 1e-6;
      issues.push({
        sev: samePart ? 'warning' : moved ? 'info' : 'hint', code: samePart ? 'duplicate-node' : 'redefined-node',
        msg: samePart
          ? `Node "${name}" is defined twice in part "${row.src.part}"; the later row wins`
          : `Node "${name}" redefines the one from part "${prev.row.src.part}"${moved ? ' at a different position' : ''}; this definition wins`,
        file: row.src.file, s: row.src.node.s, e: row.src.node.e, part: row.src.part,
      });
      nodes[existing] = node;
    } else {
      nodeIndex.set(name, nodes.length);
      nodes.push(node);
    }
  }

  const linkSev = loose ? 'info' : 'warning';
  const link = (row: Row, key: string, optional = false): number => {
    const val = row.v[key];
    if (val === undefined || val === null || val === '') return -1;
    const idx = nodeIndex.get(String(val));
    if (idx === undefined) {
      if (!optional && row.v.optional !== true) {
        issues.push({
          sev: linkSev, code: 'missing-node',
          msg: `${row.src.section}: node "${val}" not found${loose ? ' in this file' : ' — the game discards this row'}`,
          file: row.src.file, s: row.src.node.s, e: row.src.node.e, part: row.src.part,
        });
      }
      return -1;
    }
    return idx;
  };

  // --- beams / hydros
  const beams: VBeam[] = [];
  for (const section of ['beams', 'hydros'] as const) {
    for (const row of tableRows.get(section) ?? []) {
      const a = link(row, 'id1:');
      const b = a < 0 ? -1 : link(row, 'id2:');
      if (a < 0 || b < 0) continue;
      let type: BeamType = section === 'hydros' ? 'HYDRO' : beamTypeOf(row.v.beamType);
      if (section === 'beams' && row.v['id3:'] !== undefined && row.v['id3:'] !== '') type = 'LBEAM';
      beams.push({ a, b, type, section, row });
    }
  }

  // --- triangles / quads
  const tris: VTri[] = [];
  for (const row of tableRows.get('triangles') ?? []) {
    const a = link(row, 'id1:');
    const b = a < 0 ? -1 : link(row, 'id2:');
    const c = b < 0 ? -1 : link(row, 'id3:');
    if (a < 0 || b < 0 || c < 0) continue;
    tris.push({ a, b, c, section: 'triangles', row });
  }
  for (const row of tableRows.get('quads') ?? []) {
    const a = link(row, 'id1:');
    const b = a < 0 ? -1 : link(row, 'id2:');
    const c = b < 0 ? -1 : link(row, 'id3:');
    const d = c < 0 ? -1 : link(row, 'id4:');
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    tris.push({ a, b, c, section: 'quads', row });
    tris.push({ a: c, b: d, c: a, section: 'quads', row });
  }

  // --- wheels
  const wheels: VWheel[] = [];
  for (const section of WHEEL_SECTIONS) {
    for (const row of tableRows.get(section) ?? []) {
      const v = row.v;
      if (typeof v.numRays === 'number' && v.numRays <= 0) continue;
      const n1 = link(row, 'node1:');
      const n2 = n1 < 0 ? -1 : link(row, 'node2:');
      if (n1 < 0 || n2 < 0) continue;
      const radius = numOr(v.radius, 0.5);
      const hasTire = v.hasTire !== false && section !== 'hubWheels' ? true : v.hasTire === true;
      const a = nodes[n1], b = nodes[n2];
      const axisLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      wheels.push({
        name: String(v.name ?? ''), section, n1, n2,
        nodeArm: link(row, 'nodeArm:', true),
        nodeS: v.nodeS !== undefined && v.nodeS !== 9999 ? (nodeIndex.get(String(v.nodeS)) ?? -1) : -1,
        radius,
        hubRadius: numOr(v.hubRadius, 0.65 * radius),
        tireWidth: numOr(v.tireWidth, numOr(v.hubWidth, axisLen)),
        hubWidth: numOr(v.hubWidth, axisLen),
        wheelOffset: numOr(v.wheelOffset, 0),
        wheelDir: numOr(v.wheelDir, 1),
        hasTire,
        numRays: numOr(v.numRays, 10),
        row,
      });
    }
  }

  // --- flexbodies
  const flexbodies: VFlexbody[] = [];
  for (const row of tableRows.get('flexbodies') ?? []) {
    const v = row.v;
    if (typeof v.mesh !== 'string' || !v.mesh) continue;
    // meshs.lua: flexbody pos/rot get the row's nodeRotate/nodeOffset/nodeMove applied
    let pos = xyz(v.pos), rot = xyz(v.rot);
    const fx = flexbodyXform(getNodeXform(v), pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? 0, rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0);
    if (fx) {
      pos = [fx.pos.x, fx.pos.y, fx.pos.z];
      if (fx.rot) rot = [fx.rot.x, fx.rot.y, fx.rot.z];
    }
    flexbodies.push({ mesh: v.mesh.trim(), groups: groupsOf(v['[group]:']), pos, rot, scale: xyz(v.scale), row, occupant: isOccupant(row.part) });
  }

  // --- props
  const props: VProp[] = [];
  for (const row of tableRows.get('props') ?? []) {
    const v = row.v;
    if (typeof v.mesh !== 'string') continue;
    const gk = ['baseTranslationGlobal', 'baseTranslationGlobalElastic', 'baseTranslationGlobalRigid'].find((k) => isDict(v[k]));
    const pxf = getNodeXform(v);
    let globalPos: [number, number, number] | null = null;
    if (gk) {
      const g = xyz(v[gk])!;
      const q = applyNodeXform(pxf, g[0], g[1], g[2]);
      globalPos = [q.x, q.y, q.z];
    }
    props.push({
      globalPos,
      xfRot: pxf.hasRot ? pxf.rot : null,
      func: String(v.func ?? ''), mesh: v.mesh.trim(),
      idRef: link(row, 'idRef:'), idX: link(row, 'idX:'), idY: link(row, 'idY:'), row,
    });
  }

  // --- refNodes
  const refNodes: Record<string, string> = {};
  const refRow = (tableRows.get('refNodes') ?? [])[0];
  if (refRow) {
    for (const k in refRow.v) {
      if (k.endsWith(':') && typeof refRow.v[k] === 'string') refNodes[k.slice(0, -1)] = refRow.v[k];
    }
  }

  const partsByName = new Map<string, ActivePart>();
  for (const p of parts) partsByName.set(p.def.name, p);

  return {
    mainPart: root?.def.name ?? '', root, parts, partsByName, options, tables: tableRows, headers, dicts,
    nodes, nodeIndex, beams, tris, wheels, flexbodies, props, variables, vars, issues, refNodes,
    triggers: [...(tableRows.get('triggers2') ?? []), ...(tableRows.get('triggers') ?? [])],
  };
}

export function assembleVehicle(lib: PartLibrary, config: VehicleConfig): Vehicle | null {
  const res = resolveTree(lib, config);
  if (!res.root) return null;
  return buildVehicle(res.parts, config, res.issues);
}

export function assembleLoose(defs: PartDef[]): Vehicle {
  return buildVehicle(looseParts(defs), {}, [], { loose: true });
}

export function srcOf(row: Row): SrcRef {
  return row.src;
}

export type { AObj };
