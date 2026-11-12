import { parseSjson, toJs, objGet, type ANode, type AObj, type AArr } from '../sjson';
import type { JFile, PartDef, SlotDef } from './types';

const SLOT_META = new Set(['name', 'type', 'allowTypes', 'denyTypes', 'default', 'description', 'maxRecursion', 'variables', 'coreSlot']);

function isDictNode(n: ANode | undefined): n is AObj {
  return !!n && n.k === 'obj';
}

function asStringList(v: any): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  return [];
}

/**
 * Parses a `slots` (v1) or `slots2` section into normalized slot definitions,
 * mirroring io.lua processSlotsDestructive (including the missing-header fallback).
 */
export function parseSlots(table: ANode | undefined, v2: boolean): SlotDef[] {
  const out: SlotDef[] = [];
  if (!table || table.k !== 'arr' || table.items.length === 0) return out;
  const rows = table.items;
  let header: string[];
  let start = 1;
  const first = rows[0];
  const firstVals = first.k === 'arr' ? first.items.map((x) => (x.k === 'str' ? x.v : null)) : [];
  if (v2) {
    header = firstVals.every((x) => typeof x === 'string') && firstVals.includes('name')
      ? (firstVals as string[])
      : ['name', 'allowTypes', 'denyTypes', 'default', 'description'];
    if (!firstVals.includes('name')) start = 0;
  } else if (firstVals[0] === 'type') {
    header = firstVals.map((x) => x ?? '');
  } else {
    // legacy parts without a header row
    header = ['type', 'default', 'description'];
    start = 0;
  }
  let local: Record<string, any> = {};
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    if (row.k === 'obj') {
      local = { ...local, ...toJs(row) };
      continue;
    }
    if (row.k !== 'arr') continue;
    const vals: Record<string, any> = { ...local };
    for (let c = 0; c < row.items.length; c++) {
      const cell = row.items[c];
      if (cell.k === 'obj' && c >= header.length) {
        Object.assign(vals, toJs(cell));
        break;
      }
      if (c < header.length) vals[header[c]] = toJs(cell);
      else if (cell.k === 'obj') Object.assign(vals, toJs(cell));
    }
    const options: Record<string, any> = {};
    for (const k in vals) if (!SLOT_META.has(k)) options[k] = vals[k];
    let slot: SlotDef;
    if (v2) {
      if (typeof vals.name !== 'string') continue;
      slot = {
        name: vals.name,
        allowTypes: asStringList(vals.allowTypes),
        denyTypes: asStringList(vals.denyTypes),
        default: typeof vals.default === 'string' ? vals.default : undefined,
        description: typeof vals.description === 'string' ? vals.description : vals.name,
        options,
      };
    } else {
      if (typeof vals.type !== 'string') continue;
      slot = {
        name: typeof vals.name === 'string' ? vals.name : vals.type,
        type: vals.type,
        allowTypes: [vals.type],
        denyTypes: [],
        default: typeof vals.default === 'string' ? vals.default : undefined,
        description: typeof vals.description === 'string' ? vals.description : vals.type,
        options,
      };
    }
    if (vals.coreSlot === true) slot.coreSlot = true;
    if (typeof vals.maxRecursion === 'number') slot.maxRecursion = vals.maxRecursion;
    if (vals.variables && typeof vals.variables === 'object') slot.variables = vals.variables;
    slot.row = row;
    slot.table = table;
    out.push(slot);
  }
  return out;
}

export function buildParts(path: string, root: ANode | null): PartDef[] {
  const parts: PartDef[] = [];
  if (!root || root.k !== 'obj') return parts;
  for (let i = 0; i < root.keys.length; i++) {
    const key = root.keys[i];
    const node = root.vals[i];
    if (node.k !== 'obj') continue;
    const sections = new Map<string, ANode>();
    const sectionKeys = new Map<string, any>();
    for (let j = 0; j < node.keys.length; j++) {
      sections.set(node.keys[j].v, node.vals[j]);
      sectionKeys.set(node.keys[j].v, node.keys[j]);
    }
    const st = toJs(sections.get('slotType'));
    const slotTypes = asStringList(st);
    const infoNode = sections.get('information');
    const info = isDictNode(infoNode) ? toJs(infoNode) : {};
    const slots2 = sections.get('slots2');
    const slots1 = sections.get('slots');
    // io.lua: `slots` wins when both exist
    const slots = slots1 ? parseSlots(slots1, false) : parseSlots(slots2, true);
    parts.push({
      name: key.v,
      file: path,
      node,
      key,
      slotTypes,
      slots,
      // names can be localisation objects ({"txt": "...", "ctx": "..."})
      info: { name: textOf(info?.name), authors: textOf(info?.authors), value: typeof info?.value === 'number' ? info.value : undefined },
      sections,
      sectionKeys,
    });
  }
  return parts;
}

function textOf(v: any): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && typeof v.txt === 'string') return v.txt;
  return undefined;
}

export function parseJbeamFile(path: string, text: string): JFile {
  const res = parseSjson(text);
  return { path, text, root: res.root, issues: res.issues, parts: buildParts(path, res.root) };
}

/** Header (column names) of a table section, or null if the section is not a table. */
export function tableHeader(table: ANode | undefined): string[] | null {
  if (!table || table.k !== 'arr' || table.items.length === 0) return null;
  const h = table.items[0];
  if (h.k !== 'arr') return null;
  const out: string[] = [];
  for (const c of h.items) {
    if (c.k !== 'str') return null;
    out.push(c.v);
  }
  return out;
}

export function isTableRow(n: ANode): n is AArr {
  return n.k === 'arr';
}

export { objGet };
