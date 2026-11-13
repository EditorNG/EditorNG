/**
 * Surgical text edits on JBeam source. The text is the source of truth: every 3D tool produces
 * minimal edits so comments, ordering and formatting of untouched content are preserved.
 */
import { parseSjson as _ps, toJs } from '../sjson';
import type { ANode, AArr, AObj } from '../sjson';
import type { PartDef } from './types';

export interface TextEdit {
  s: number;
  e: number;
  text: string;
}

export interface FmtOpts {
  decimals: number;
}

export const DEFAULT_FMT: FmtOpts = { decimals: 3 };

export function fmtNum(n: number, decimals = 3): string {
  if (n === Infinity) return '"FLT_MAX"';
  if (n === -Infinity) return '"MINUS_FLT_MAX"';
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

export function fmtValue(v: any, decimals = 3): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') return fmtNum(v, decimals);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => fmtValue(x, decimals)).join(', ') + ']';
  const keys = Object.keys(v);
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + fmtValue(v[k], decimals)).join(', ') + '}';
}

export function fmtRow(cells: any[], decimals = 3): string {
  return '[' + cells.map((c) => fmtValue(c, decimals)).join(', ') + ']';
}

/** Builds row cells from a record using a header; keys not in the header go into a trailing options dict. */
export function rowFromRecord(header: string[], rec: Record<string, any>): any[] {
  const cells: any[] = [];
  let last = -1;
  for (let i = 0; i < header.length; i++) if (rec[header[i]] !== undefined) last = i;
  const extra: Record<string, any> = {};
  for (const k in rec) if (!header.includes(k) && rec[k] !== undefined) extra[k] = rec[k];
  const hasExtra = Object.keys(extra).length > 0;
  const n = hasExtra ? header.length : last + 1;
  for (let i = 0; i < n; i++) {
    const v = rec[header[i]];
    cells.push(v === undefined ? defaultCell(header[i]) : v);
  }
  if (hasExtra) cells.push(extra);
  return cells;
}

function defaultCell(col: string): any {
  if (col.startsWith('[') || col === 'nonFlexMaterials') return [];
  if (/^(posX|posY|posZ|min|max|offset|multiplier)$/.test(col)) return 0;
  if (/^(baseRotation|rotation|translation|baseTranslation|size)$/.test(col)) return { x: 0, y: 0, z: 0 };
  return '';
}

export const DEFAULT_HEADERS: Record<string, string[]> = {
  nodes: ['id', 'posX', 'posY', 'posZ'],
  beams: ['id1:', 'id2:'],
  triangles: ['id1:', 'id2:', 'id3:'],
  quads: ['id1:', 'id2:', 'id3:', 'id4:'],
  hydros: ['id1:', 'id2:'],
  torsionbars: ['id1:', 'id2:', 'id3:', 'id4:'],
  flexbodies: ['mesh', '[group]:', 'nonFlexMaterials'],
  props: ['func', 'mesh', 'idRef:', 'idX:', 'idY:', 'baseRotation', 'rotation', 'translation', 'min', 'max', 'offset', 'multiplier'],
  triggers2: ['id', 'idRef:', 'idX:', 'idY:', 'type', 'size', 'baseRotation', 'rotation', 'translation', 'baseTranslation'],
  triggerEventLinks2: ['triggerId:triggers2', 'triggerInput', 'inputAction'],
  actionsEnabled: ['id'],
  slots2: ['name', 'allowTypes', 'denyTypes', 'default', 'description'],
  refNodes: ['ref:', 'back:', 'left:', 'up:'],
  slidenodes: ['id:', 'railName', 'attached', 'fixToRail', 'tolerance', 'spring', 'strength', 'capStrength'],
  pressureWheels: ['name', 'hubGroup', 'group', 'node1:', 'node2:', 'nodeS', 'nodeArm:', 'wheelDir'],
  cameraExternal: ['distance', 'distanceMin', 'offset', 'fov'],
};

// ---------------------------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------------------------

export function eolOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text.charCodeAt(i - 1) === 13 ? '\r\n' : '\n';
}

export function indentUnitOf(text: string): string {
  const m = /\n(\t+|[ ]{2,8})["[{]/.exec(text);
  if (!m) return '    ';
  if (m[1][0] === '\t') return '\t';
  // smallest indentation step
  let min = 8;
  const re = /\n([ ]+)\S/g;
  let r: RegExpExecArray | null;
  let n = 0;
  while ((r = re.exec(text)) && n++ < 400) if (r[1].length < min) min = r[1].length;
  return ' '.repeat(Math.max(2, Math.min(min, 4)));
}

export function lineStart(text: string, off: number): number {
  const i = text.lastIndexOf('\n', off - 1);
  return i + 1;
}

/** offset of the line break that ends the line containing off (exclusive of \r) */
export function lineEndOff(text: string, off: number): number {
  let i = text.indexOf('\n', off);
  if (i < 0) i = text.length;
  if (i > 0 && text.charCodeAt(i - 1) === 13) i--;
  return i;
}

export function indentAt(text: string, off: number): string {
  const s = lineStart(text, off);
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

function onlyWsBefore(text: string, off: number): boolean {
  const s = lineStart(text, off);
  return /^[ \t]*$/.test(text.slice(s, off));
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  let lastS = Infinity;
  for (const ed of sorted) {
    if (ed.e > lastS) continue; // overlapping edit: skip the later one
    out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
    lastS = ed.s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// structural edits
// ---------------------------------------------------------------------------------------------

/** Inserts formatted rows at the end of a part's table section, creating the section if needed. */
export function insertRows(text: string, part: PartDef, section: string, header: string[], rows: string[]): TextEdit[] {
  if (rows.length === 0) return [];
  const eol = eolOf(text);
  const unit = indentUnitOf(text);
  // multi-line rows: continuation lines get the row indentation; tabs inside a row become indent units
  const ml = (ind: string) => (r: string) => r.replace(/\r?\n/g, eol + ind).replace(/\t/g, unit);
  const sec = part.sections.get(section);
  if (sec && sec.k === 'arr') {
    const items = sec.items;
    const closeOff = sec.e - 1;
    if (items.length === 0) {
      const keyIndent = indentAt(text, sec.s);
      const ind = keyIndent + unit;
      const body = [fmtRow(header), ...rows.map(ml(ind))].map((r) => ind + r + ',').join(eol);
      return [{ s: sec.s + 1, e: closeOff, text: eol + body + eol + keyIndent }];
    }
    const last = items[items.length - 1];
    const ind = onlyWsBefore(text, last.s) ? indentAt(text, last.s) : indentAt(text, sec.s) + unit;
    rows = rows.map(ml(ind));
    const lastLineEnd = lineEndOff(text, last.e);
    const between = text.slice(last.e, Math.min(lastLineEnd, closeOff));
    const hasComma = /^\s*,/.test(between);
    const edits: TextEdit[] = [];
    if (closeOff > lastLineEnd) {
      // closing bracket is on a later line: append after the last row's line
      if (!hasComma) edits.push({ s: last.e, e: last.e, text: ',' });
      edits.push({ s: lastLineEnd, e: lastLineEnd, text: rows.map((r) => eol + ind + r + ',').join('') });
    } else {
      const keyIndent = indentAt(text, sec.s);
      edits.push({
        s: last.e,
        e: last.e,
        text: (hasComma ? '' : ',') + rows.map((r) => eol + ind + r).join(',') + ',' + (hasComma ? '' : eol + keyIndent),
      });
      if (hasComma) {
        // "[..., lastRow, ]" on one line: push the bracket to its own line
        edits.push({ s: closeOff, e: closeOff, text: eol + keyIndent });
      }
    }
    return edits;
  }
  // create the section at the end of the part
  return insertKey(text, part.node, section, (ind) => {
    const inner = ind + unit;
    return '[' + eol + [fmtRow(header), ...rows.map(ml(inner))].map((r) => inner + r + ',').join(eol) + eol + ind + ']';
  });
}

/** Inserts `"key": value` as the last entry of an object node. */
export function insertKey(text: string, obj: AObj, key: string, value: (indent: string) => string): TextEdit[] {
  const eol = eolOf(text);
  const unit = indentUnitOf(text);
  const closeOff = obj.e - 1;
  if (obj.vals.length === 0) {
    const ind = indentAt(text, obj.s) + unit;
    return [{ s: obj.s + 1, e: closeOff, text: eol + ind + JSON.stringify(key) + ': ' + value(ind) + ',' + eol + indentAt(text, obj.s) }];
  }
  const lastKey = obj.keys[obj.keys.length - 1];
  const lastVal = obj.vals[obj.vals.length - 1];
  const ind = onlyWsBefore(text, lastKey.s) ? indentAt(text, lastKey.s) : indentAt(text, obj.s) + unit;
  const lastLineEnd = lineEndOff(text, lastVal.e);
  const hasComma = /^\s*,/.test(text.slice(lastVal.e, Math.min(lastLineEnd, closeOff)));
  const edits: TextEdit[] = [];
  const entry = JSON.stringify(key) + ': ' + value(ind) + ',';
  if (closeOff > lastLineEnd) {
    if (!hasComma) edits.push({ s: lastVal.e, e: lastVal.e, text: ',' });
    edits.push({ s: lastLineEnd, e: lastLineEnd, text: eol + ind + entry });
  } else {
    edits.push({ s: closeOff, e: closeOff, text: (hasComma ? '' : ',') + eol + ind + entry + eol + indentAt(text, obj.s) });
  }
  return edits;
}

/** Deletes whole rows. Rows alone on their lines are removed with their line. */
export function deleteNodes(text: string, nodes: ANode[]): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const n of nodes) {
    let s = n.s;
    let e = n.e;
    // swallow trailing comma
    let j = e;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] === ',') e = j + 1;
    const le = lineEndOff(text, e);
    const rest = text.slice(e, le);
    if (onlyWsBefore(text, s) && /^[ \t]*(\/\/.*)?$/.test(rest) && !/\/\//.test(rest)) {
      s = lineStart(text, s);
      e = le;
      if (text[e] === '\r') e++;
      if (text[e] === '\n') e++;
    } else {
      while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
    }
    edits.push({ s, e, text: '' });
  }
  return mergeEdits(edits);
}

export function mergeEdits(edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.s - b.s || a.e - b.e);
  const out: TextEdit[] = [];
  for (const ed of sorted) {
    const prev = out[out.length - 1];
    if (prev && ed.s < prev.e) {
      if (ed.text === '' && prev.text === '') prev.e = Math.max(prev.e, ed.e);
      continue;
    }
    if (prev && ed.s === prev.s && ed.e === prev.e && ed.text === prev.text) continue;
    out.push({ ...ed });
  }
  return out;
}

/** Replaces a cell with a new literal value. */
export function setCell(cell: ANode, value: any, decimals = 3): TextEdit {
  return { s: cell.s, e: cell.e, text: fmtValue(value, decimals) };
}

/**
 * Sets (or adds) a key inside an inline options dict of a row; creates the dict when missing.
 * `headerLen` is the number of header columns (dicts must sit at index headerLen).
 */
export function setRowOption(text: string, row: AArr, headerLen: number, key: string, value: any, decimals = 3): TextEdit[] {
  const dict = row.items.find((c, i) => c.k === 'obj' && i >= headerLen - 0) as AObj | undefined;
  if (dict) {
    for (let i = dict.keys.length - 1; i >= 0; i--) {
      if (dict.keys[i].v === key) return [{ s: dict.vals[i].s, e: dict.vals[i].e, text: fmtValue(value, decimals) }];
    }
    const entry = JSON.stringify(key) + ':' + fmtValue(value, decimals);
    if (dict.vals.length === 0) return [{ s: dict.s + 1, e: dict.e - 1, text: entry }];
    const last = dict.vals[dict.vals.length - 1];
    return [{ s: last.e, e: last.e, text: ', ' + entry }];
  }
  const fill: string[] = [];
  for (let i = row.items.length; i < headerLen; i++) fill.push('""');
  const last = row.items[row.items.length - 1];
  const at = last ? last.e : row.s + 1;
  const prefix = last ? ', ' : '';
  return [{ s: at, e: at, text: prefix + [...fill, '{' + JSON.stringify(key) + ':' + fmtValue(value, decimals) + '}'].join(', ') }];
}

// ---------------------------------------------------------------------------------------------
// node references
// ---------------------------------------------------------------------------------------------

/**
 * Finds every string token in a part that refers to the node `name` (or defines it).
 * Covers table link columns (`id1:` ...), `xxx:` keys in option dicts and dict sections,
 * the `id` column of `nodes`, and `$...node...` slot variables (bulbs, occupants).
 */
export function findNodeTokens(part: PartDef, name: string): ANode[] {
  const out: ANode[] = [];
  const visitDict = (o: AObj) => {
    for (let i = 0; i < o.keys.length; i++) {
      const key = o.keys[i].v;
      const v = o.vals[i];
      if (isLinkKey(key) || (key.charCodeAt(0) === 36 && /node/i.test(key))) {
        collectStr(v, name, out);
      } else if (v.k === 'obj') {
        visitDict(v);
      } else if (v.k === 'arr' && key !== 'nodes') {
        for (const it of v.items) if (it.k === 'obj') visitDict(it);
      }
    }
  };
  for (const [section, node] of part.sections) {
    if (node.k === 'obj') {
      visitDict(node);
      continue;
    }
    if (node.k !== 'arr' || node.items.length === 0) continue;
    const h = node.items[0];
    const header = h.k === 'arr' ? h.items.map((x) => (x.k === 'str' ? x.v : '')) : [];
    for (let r = 1; r < node.items.length; r++) {
      const row = node.items[r];
      if (row.k === 'obj') {
        visitDict(row);
        continue;
      }
      if (row.k !== 'arr') continue;
      for (let c = 0; c < row.items.length; c++) {
        const cell = row.items[c];
        const key = header[c];
        if (cell.k === 'obj') {
          visitDict(cell);
          continue;
        }
        if (key === undefined) continue;
        if ((section === 'nodes' && key === 'id') || isLinkKey(key)) collectStr(cell, name, out);
      }
    }
  }
  return out;
}

export function isLinkKey(key: string): boolean {
  if (!key.endsWith(':')) {
    // "triggerId:triggers2" style links into other sections are not node links
    return false;
  }
  if (key.startsWith('[')) return false; // [group]: lists
  return true;
}

function collectStr(v: ANode, name: string, out: ANode[]): void {
  if (v.k === 'str') {
    if (v.v === name) out.push(v);
  } else if (v.k === 'arr') {
    for (const it of v.items) collectStr(it, name, out);
  }
}


/**
 * Inserts row texts right after an existing row (same indentation, one per line).
 * Adds the missing comma after the existing row when needed.
 */
export function insertRowsAfter(text: string, row: ANode, rows: string[]): TextEdit[] {
  if (!rows.length) return [];
  const eol = eolOf(text);
  const ind = indentAt(text, row.s);
  let j = row.e;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  const hasComma = text[j] === ',';
  const edits: TextEdit[] = [];
  if (!hasComma) edits.push({ s: row.e, e: row.e, text: ',' });
  const after = hasComma ? j + 1 : row.e;
  const le = lineEndOff(text, after);
  // other rows on the same line: insert right after this row instead of at the line end
  const sameLineRest = text.slice(after, le).trim();
  const at = sameLineRest && !sameLineRest.startsWith('//') ? after : le;
  edits.push({ s: at, e: at, text: rows.map((r) => eol + ind + r + ',').join('') });
  return edits;
}

/** Replaces cells of a row's text by column (header) index; returns the new row text. */
export function setRowCellsText(rowText: string, header: string[], values: Record<string, any>, decimals = 3): string {
  const parsed = _ps(rowText);
  const arr = parsed.root;
  if (!arr || arr.k !== 'arr') return rowText;
  const edits: TextEdit[] = [];
  const opts: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    const i = header.indexOf(k);
    const cell = i >= 0 ? arr.items[i] : undefined;
    if (cell) edits.push({ s: cell.s, e: cell.e, text: fmtValue(v, decimals) });
    else opts[k] = v;
  }
  if (Object.keys(opts).length) edits.push(...setRowOptionsMany(rowText, arr, header.length, opts, decimals));
  return applyEdits(rowText, edits);
}

function setRowOptionsMany(text: string, arr: AArr, headerLen: number, opts: Record<string, any>, decimals: number): TextEdit[] {
  // apply one at a time on the evolving text would shift offsets; instead merge into one options object edit
  const last = arr.items[arr.items.length - 1];
  if (last && last.k === 'obj' && arr.items.length > headerLen) {
    const cur = toJs(last) ?? {};
    const merged = { ...cur, ...opts };
    return [{ s: last.s, e: last.e, text: fmtValue(merged, decimals) }];
  }
  const end = arr.e - 1;
  return [{ s: end, e: end, text: (arr.items.length ? ', ' : '') + fmtValue(opts, decimals) }];
}

/**
 * Inserts rows into a part's array section right after the line `lineEnd` belongs to (an offset in that line,
 * usually the code cursor). Returns null when that line is not inside the section, so the caller can append
 * at the end instead. `at` is the offset (in the old text) where the new rows' text goes.
 */
export function insertRowsAtLine(text: string, part: PartDef, section: string, rows: string[], cursor: number): { edits: TextEdit[]; at: number } | null {
  if (!rows.length) return null;
  const sec = part.sections.get(section);
  if (!sec || sec.k !== 'arr' || !sec.items.length) return null;
  const closeOff = sec.e - 1;
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const lineEnd = lineEndOff(text, cursor);
  // the line must lie between the section's opening bracket line and its closing bracket
  if (lineEnd < sec.s || lineEnd >= closeOff || lineStart > closeOff) return null;
  const items = sec.items;
  let anchor = items[0];
  for (const it of items) if (it.s < lineEnd) anchor = it;
  const eol = eolOf(text);
  const unit = indentUnitOf(text);
  const ind = onlyWsBefore(text, anchor.s) ? indentAt(text, anchor.s) : indentAt(text, sec.s) + unit;
  const body = rows.map((r) => eol + ind + r.replace(/\r?\n/g, eol + ind).replace(/\t/g, unit) + ',').join('');
  let j = anchor.e;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  const hasComma = text[j] === ',';
  let at: number;
  if (anchor.e < lineStart) {
    // the cursor sits on a blank or comment line between rows: insert right below it
    at = lineEnd;
  } else {
    const after = hasComma ? j + 1 : anchor.e;
    const le = lineEndOff(text, after);
    const rest = text.slice(after, le).trim();
    at = rest && !rest.startsWith('//') ? after : le;
  }
  // the anchor's missing comma: in the same edit when it is at the same spot (edit order would swap them)
  const edits: TextEdit[] = [];
  if (!hasComma && at !== anchor.e) edits.push({ s: anchor.e, e: anchor.e, text: ',' });
  edits.push({ s: at, e: at, text: (!hasComma && at === anchor.e ? ',' : '') + body });
  return { edits, at };
}
