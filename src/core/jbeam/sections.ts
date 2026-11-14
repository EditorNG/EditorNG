/**
 * Blank sections and parts for the code editor's Add menu: what each section looks like when
 * empty (header row for tables, the usual keys for objects), and where it goes in the text.
 * The cursor marker CURSOR (U+0000) in generated text marks where the caret goes afterwards.
 */
import type { AObj } from '../sjson';
import { DEFAULT_HEADERS, eolOf, indentUnitOf, fmtRow, type TextEdit } from './edit';

export const CURSOR = '\u0000';

export interface SectionDef {
  key: string;
  label: string;
  group: string;
  /** table header (array section) */
  header?: string[];
  /** body of an object section, one entry per line */
  object?: Array<[string, string]>;
  /** a plain value (slotType) */
  value?: string;
}

const T = (key: string, group: string, header: string[]): SectionDef => ({ key, label: key, group, header });
const O = (key: string, group: string, object: Array<[string, string]>): SectionDef => ({ key, label: key, group, object });

export const SECTION_DEFS: SectionDef[] = [
  O('information', 'Part', [['authors', '""'], ['name', '""'], ['value', '0']]),
  { key: 'slotType', label: 'slotType', group: 'Part', value: '""' },
  T('slots2', 'Part', DEFAULT_HEADERS.slots2),
  T('variables', 'Part', ['name', 'type', 'unit', 'category', 'default', 'min', 'max', 'title', 'description']),
  O('components', 'Part', []),

  T('nodes', 'Structure', DEFAULT_HEADERS.nodes),
  T('beams', 'Structure', DEFAULT_HEADERS.beams),
  T('triangles', 'Structure', DEFAULT_HEADERS.triangles),
  T('quads', 'Structure', DEFAULT_HEADERS.quads),
  T('hydros', 'Structure', DEFAULT_HEADERS.hydros),
  T('torsionbars', 'Structure', DEFAULT_HEADERS.torsionbars),
  T('refNodes', 'Structure', ['ref:', 'back:', 'left:', 'up:', 'leftCorner:', 'rightCorner:']),
  O('rails', 'Structure', []),
  T('slidenodes', 'Structure', DEFAULT_HEADERS.slidenodes),

  T('flexbodies', 'Meshes & lights', DEFAULT_HEADERS.flexbodies),
  T('props', 'Meshes & lights', DEFAULT_HEADERS.props),
  O('glowMap', 'Meshes & lights', []),

  T('triggers2', 'Interaction', DEFAULT_HEADERS.triggers2),
  T('triggerEventLinks2', 'Interaction', DEFAULT_HEADERS.triggerEventLinks2),
  T('actionsEnabled', 'Interaction', DEFAULT_HEADERS.actionsEnabled),

  T('controller', 'Systems', ['fileName']),
  T('powertrain', 'Systems', ['type', 'name', 'inputName', 'inputIndex']),
  T('pressureWheels', 'Systems', DEFAULT_HEADERS.pressureWheels),
  O('cameraExternal', 'Systems', [['distance', '6'], ['distanceMin', '3'], ['offset', '{"x":0, "y":0, "z":0.6}'], ['fov', '65']]),
  T('camerasInternal', 'Systems', ['type', 'x', 'y', 'z', 'fov', 'id1:', 'id2:', 'id3:', 'id4:', 'id5:', 'id6:']),
];

export const SECTION_BY_KEY = new Map(SECTION_DEFS.map((d) => [d.key, d]));

/** The text of an empty section's value, with CURSOR where the caret goes. */
export function sectionValue(def: SectionDef, ind: string, unit: string, eol: string): string {
  const i1 = ind + unit;
  if (def.value !== undefined) return def.value.replace('""', '"' + CURSOR + '"');
  if (def.header) return '[' + eol + i1 + fmtRow(def.header) + ',' + eol + i1 + CURSOR + eol + ind + ']';
  const rows = def.object ?? [];
  if (!rows.length) return '{' + eol + i1 + CURSOR + eol + ind + '}';
  return '{' + eol + rows.map(([k, v], i) => i1 + JSON.stringify(k) + ': ' + (i === 0 ? v.replace('""', '"' + CURSOR + '"') : v) + ',').join(eol) + eol + ind + '}';
}

const lineStart = (t: string, o: number) => t.lastIndexOf('\n', o - 1) + 1;
const indentOf = (t: string, o: number) => /^[ \t]*/.exec(t.slice(lineStart(t, o)))![0];

/**
 * Inserts `"key": value,` into an object, before its key number `before` (on its own line, same
 * indentation), or after its last key when `before` is null or past the end. When the value holds
 * CURSOR, `cursor` is where it lands in the new text (the marker itself is removed).
 */
export function insertKeyAt(
  text: string,
  obj: AObj,
  before: number | null,
  key: string,
  value: (indent: string, unit: string, eol: string) => string,
): { edits: TextEdit[]; cursor: number | null } {
  const eol = eolOf(text);
  const unit = indentUnitOf(text);
  const entry = (ind: string) => JSON.stringify(key) + ': ' + value(ind, unit, eol) + ',';
  if (before !== null && before < obj.keys.length) {
    const k = obj.keys[before];
    const at = lineStart(text, k.s);
    const ind = indentOf(text, k.s);
    return finish([{ s: at, e: at, text: ind + entry(ind) + eol }]);
  }
  if (!obj.keys.length) {
    const ind = indentOf(text, obj.s) + unit;
    return finish([{ s: obj.s + 1, e: obj.e - 1, text: eol + ind + entry(ind) + eol + indentOf(text, obj.s) }]);
  }
  const lastVal = obj.vals[obj.vals.length - 1];
  const ind = indentOf(text, obj.keys[obj.keys.length - 1].s);
  const edits: TextEdit[] = [];
  let e = lastVal.e;
  const comma = /^[ \t]*,/.exec(text.slice(e));
  if (comma) e += comma[0].length;
  else edits.push({ s: lastVal.e, e: lastVal.e, text: ',' });
  // at the end of that line (a trailing comment stays on it), unless the object closes on that line
  let le = text.indexOf('\n', e);
  if (le < 0 || le > obj.e - 1) {
    const ins = eol + ind + entry(ind) + eol + indentOf(text, obj.s);
    if (edits.length && edits[0].s === obj.e - 1) edits[0].text += ins;
    else edits.push({ s: obj.e - 1, e: obj.e - 1, text: ins });
    return finish(edits);
  }
  if (text[le - 1] === '\r') le--;
  const ins = eol + ind + entry(ind);
  // same spot as the missing comma: one insert, comma first
  if (edits.length && edits[0].s === le) edits[0].text += ins;
  else edits.push({ s: le, e: le, text: ins });
  return finish(edits);
}

function finish(edits: TextEdit[]): { edits: TextEdit[]; cursor: number | null } {
  // edits apply together: the cursor offset in the final text includes earlier inserts
  let cursor: number | null = null;
  let shift = 0;
  const out: TextEdit[] = [];
  for (const ed of [...edits].sort((a, b) => a.s - b.s)) {
    const m = ed.text.indexOf(CURSOR);
    if (m >= 0 && cursor === null) cursor = ed.s + shift + m;
    const t = ed.text.replace(CURSOR, '');
    out.push({ ...ed, text: t });
    shift += t.length - (ed.e - ed.s);
  }
  return { edits: out, cursor };
}

/** Applies edits to a string (tests and previews). */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const ed of [...edits].sort((a, b) => b.s - a.s)) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
  return out;
}

/** A whole blank part's value: information, slotType and the chosen sections. */
export function partValue(o: { authors: string; name: string; value: number; slotType: string; sections: string[] }, ind: string, unit: string, eol: string): string {
  const i1 = ind + unit;
  const lines = [
    '{',
    i1 + '"information":{',
    i1 + unit + '"authors":' + JSON.stringify(o.authors) + ',',
    i1 + unit + '"name":' + JSON.stringify(o.name) + ',',
    i1 + unit + '"value":' + (Number.isFinite(o.value) ? o.value : 0) + ',',
    i1 + '},',
    i1 + '"slotType" : ' + JSON.stringify(o.slotType) + ',',
  ];
  for (const k of o.sections) {
    const def = SECTION_BY_KEY.get(k);
    if (!def || k === 'information' || k === 'slotType') continue;
    // empty tables keep their header and one blank line to type in
    lines.push(i1 + JSON.stringify(k) + ': ' + sectionValue(def, i1, unit, eol).split(CURSOR).join('') + ',');
  }
  lines.push(ind + '}');
  return lines.join(eol).replace(/[ \t]+(\r?\n)/g, '$1');
}

export { indentUnitOf, eolOf };
