/**
 * Editing operations used by the 3D tools. Each produces minimal text edits.
 */
import { ws, useWs, type Doc } from './workspace';
import {
  DEFAULT_HEADERS, deleteNodes, fmtNum, fmtRow, fmtValue, insertRows, rowFromRecord, setRowOption, findNodeTokens, insertKey, eolOf, indentUnitOf, insertRowsAfter, setRowCellsText, type TextEdit,
} from '@core/jbeam/edit';
import { getNodeXform, invertNodeXform } from '@core/jbeam/nodeTransform';
import type { ANode, AArr } from '@core/sjson';
import type { ActivePart, PartDef, Row, Vehicle } from '@core/jbeam/types';
import { settings } from '../state/settings';
import { useUi } from '../state/ui';
import { collectRails, collectSlides, closestOnRail, railPoints } from '@core/jbeam/rails';
import { placeTriggers, mirroredTriggerValues } from '@core/jbeam/triggers';
import { swapSideTokens } from '@core/jbeam/mirror';
import { toast } from '../state/toast';
import { useSel, emptySel, beamKey, triKey, cloneSel, resolveSel, setSel } from '../state/selection';

class EditSet {
  map = new Map<string, TextEdit[]>();
  add(doc: string, edits: TextEdit[]) {
    if (!edits.length) return;
    const k = doc.toLowerCase();
    const l = this.map.get(k);
    if (l) l.push(...edits);
    else this.map.set(k, [...edits]);
  }
  get size() {
    return this.map.size;
  }
  apply(label: string): boolean {
    if (!this.map.size) return false;
    return ws.applyEdits(label, this.map);
  }
}

function dec(): number {
  return settings().decimals;
}

function docText(key: string): string {
  return ws.doc(key)?.text ?? '';
}

function headerOf(table: ANode | undefined, section: string): string[] {
  if (table && table.k === 'arr' && table.items[0]?.k === 'arr') {
    return (table.items[0] as AArr).items.map((x) => (x.k === 'str' ? x.v : ''));
  }
  return DEFAULT_HEADERS[section] ?? [];
}

function writableDoc(key: string): Doc | null {
  const d = ws.doc(key);
  if (!d) return null;
  if (!d.writable) {
    toast('warn', `${d.name} is read-only (${d.source}). Right-click it in the explorer → "Make editable copy".`);
    return null;
  }
  return d;
}

/** The part that receives new rows. */
export function targetPart(): { doc: Doc; part: PartDef; active?: ActivePart } | null {
  const t = useWs.getState().target;
  const v = ws.vehicle;
  if (t) {
    const d = ws.doc(t.doc);
    const p = d?.jfile?.parts.find((x) => x.name === t.part);
    if (d && p && d.writable) return { doc: d, part: p, active: v?.partsByName.get(p.name) };
  }
  // fallback: main part if writable, else first writable part with nodes
  if (v) {
    for (const ap of v.parts) {
      const d = ws.doc(ap.def.file);
      if (d?.writable && !d.isCommon) return { doc: d, part: ap.def, active: ap };
    }
  }
  for (const d of ws.docs.values()) {
    if (!d.writable || d.isCommon || !d.jfile?.parts.length) continue;
    return { doc: d, part: d.jfile.parts[0] };
  }
  return null;
}

function requireTarget(): { doc: Doc; part: PartDef; active?: ActivePart } | null {
  const t = targetPart();
  if (!t) toast('warn', 'No writable target part. Open a mod vehicle or make a file editable first.');
  return t;
}

// ------------------------------------------------------------------------------------------
// nodes
// ------------------------------------------------------------------------------------------

export function nodeNameFree(v: Vehicle | null, name: string): boolean {
  return !!name && !v?.nodeIndex.has(name);
}

/** Adds nodes (final positions) to the target part. Returns the names. */
export function addNodes(nodes: Array<{ name: string; x: number; y: number; z: number; opts?: Record<string, any> }>, label = 'Add node'): string[] {
  const t = requireTarget();
  if (!t) return [];
  const v = ws.vehicle;
  for (const n of nodes) {
    if (!nodeNameFree(v, n.name)) {
      toast('warn', `Node name "${n.name}" already exists`);
      return [];
    }
  }
  const table = t.part.sections.get('nodes');
  const header = headerOf(table, 'nodes');
  const xf = getNodeXform(t.active?.slotOptions ?? {});
  const rows = nodes.map((n) => {
    const raw = invertNodeXform(xf, n.x, n.y, n.z);
    const rec: Record<string, any> = { id: n.name, posX: round(raw.x), posY: round(raw.y), posZ: round(raw.z), ...(n.opts ?? {}) };
    return fmtRow(rowFromRecord(header, rec), dec());
  });
  const es = new EditSet();
  es.add(t.doc.key, insertRows(t.doc.text, t.part, 'nodes', header, rows));
  if (!es.apply(label)) return [];
  return nodes.map((n) => n.name);
}

function round(x: number): number {
  const f = Math.pow(10, dec());
  return Math.round(x * f) / f;
}

/** Moves nodes to new final positions (inverting nodeOffset/nodeMove/nodeRotate). */
export function moveNodes(changes: Map<number, [number, number, number]>, label = 'Move nodes'): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const es = new EditSet();
  let skipped = 0;
  for (const [i, p] of changes) {
    const n = v.nodes[i];
    if (!n || n.virtual) continue;
    const row = n.row.src.node as AArr;
    if (!writableDoc(n.row.src.file)) return false;
    const header = headerOf(n.row.src.table, 'nodes');
    const cx = header.indexOf('posX'), cy = header.indexOf('posY'), cz = header.indexOf('posZ');
    const cells = [row.items[cx], row.items[cy], row.items[cz]];
    if (cells.some((c) => !c || c.k !== 'num')) {
      skipped++;
      continue;
    }
    const raw = invertNodeXform(getNodeXform(n.row.v), p[0], p[1], p[2]);
    const vals = [raw.x, raw.y, raw.z];
    const edits: TextEdit[] = [];
    cells.forEach((c, k) => {
      const t = fmtNum(vals[k], dec());
      if (t !== docText(n.row.src.file).slice(c!.s, c!.e)) edits.push({ s: c!.s, e: c!.e, text: t });
    });
    es.add(n.row.src.file, edits);
  }
  if (skipped) toast('warn', `${skipped} node(s) use expressions for their position and were not moved`);
  return es.apply(label);
}

/** Renames a node and every reference in writable documents. */
export function renameNode(oldName: string, newName: string): boolean {
  newName = newName.trim();
  const v = ws.vehicle;
  if (!v || !newName || oldName === newName) return false;
  if (/["\\\s]/.test(newName)) {
    toast('warn', 'Node names cannot contain spaces, quotes or backslashes');
    return false;
  }
  if (v.nodeIndex.has(newName)) {
    toast('warn', `"${newName}" already exists`);
    return false;
  }
  const i = v.nodeIndex.get(oldName);
  if (i !== undefined && !writableDoc(v.nodes[i].row.src.file)) return false;
  const es = new EditSet();
  let refs = 0;
  const readOnlyRefs = new Set<string>();
  for (const d of ws.docs.values()) {
    if (!d.jfile || d.isCommon) continue;
    for (const p of d.jfile.parts) {
      const toks = findNodeTokens(p, oldName);
      if (!toks.length) continue;
      if (!d.writable) {
        readOnlyRefs.add(d.name);
        continue;
      }
      refs += toks.length;
      es.add(d.key, toks.map((t) => ({ s: t.s, e: t.e, text: JSON.stringify(newName) })));
    }
  }
  if (!es.apply(`Rename ${oldName} → ${newName}`)) return false;
  // keep the selection
  const st = useSel.getState();
  if (st.sel.nodes.has(oldName)) {
    const s = cloneSel(st.sel);
    s.nodes.delete(oldName);
    s.nodes.add(newName);
    useSel.setState({ sel: s });
  }
  if (readOnlyRefs.size) toast('warn', `References in read-only files were not renamed: ${[...readOnlyRefs].join(', ')}`);
  else toast('ok', `Renamed ${oldName} → ${newName} (${refs} occurrences)`);
  return true;
}

/** Applies several renames in one undo step (used by sequential naming). */
export function renameMany(pairs: Array<[string, string]>): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const es = new EditSet();
  const taken = new Set(v.nodeIndex.keys());
  for (const [o] of pairs) taken.delete(o);
  for (const [o, n] of pairs) {
    if (taken.has(n)) {
      toast('warn', `"${n}" already exists`);
      return false;
    }
    taken.add(n);
  }
  for (const d of ws.docs.values()) {
    if (!d.jfile || d.isCommon || !d.writable) continue;
    for (const p of d.jfile.parts) for (const [o, n] of pairs) es.add(d.key, findNodeTokens(p, o).map((t) => ({ s: t.s, e: t.e, text: JSON.stringify(n) })));
  }
  return es.apply(`Rename ${pairs.length} nodes`);
}

// ------------------------------------------------------------------------------------------
// beams / triangles
// ------------------------------------------------------------------------------------------

export function hasBeam(v: Vehicle, a: number, b: number): boolean {
  return v.beams.some((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

export function addBeams(pairs: Array<[string, string]>, opts?: Record<string, any>, label = 'Add beam'): number {
  const t = requireTarget();
  const v = ws.vehicle;
  if (!t || !v) return 0;
  const seen = new Set<string>();
  const list = pairs.filter(([a, b]) => {
    const ia = v.nodeIndex.get(a), ib = v.nodeIndex.get(b);
    if (a === b || ia === undefined || ib === undefined) return false;
    const k = beamKey(a, b);
    if (seen.has(k) || hasBeam(v, ia, ib)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) {
    toast('info', 'Beam already exists');
    return 0;
  }
  const header = headerOf(t.part.sections.get('beams'), 'beams');
  const rows = list.map(([a, b]) => fmtRow(rowFromRecord(header, { 'id1:': a, 'id2:': b, ...(opts ?? {}) }), dec()));
  const es = new EditSet();
  es.add(t.doc.key, insertRows(t.doc.text, t.part, 'beams', header, rows));
  return es.apply(label) ? list.length : 0;
}

export function addTris(tris: Array<[string, string, string]>, label = 'Add triangle'): number {
  const t = requireTarget();
  const v = ws.vehicle;
  if (!t || !v) return 0;
  const existing = new Set(v.tris.map((x) => triKey(v.nodes[x.a].name, v.nodes[x.b].name, v.nodes[x.c].name)));
  const list = tris.filter((x) => new Set(x).size === 3 && x.every((n) => v.nodeIndex.has(n)) && !existing.has(triKey(...x)));
  if (!list.length) {
    toast('info', 'Triangle already exists');
    return 0;
  }
  const header = headerOf(t.part.sections.get('triangles'), 'triangles');
  const rows = list.map(([a, b, c]) => fmtRow(rowFromRecord(header, { 'id1:': a, 'id2:': b, 'id3:': c }), dec()));
  const es = new EditSet();
  es.add(t.doc.key, insertRows(t.doc.text, t.part, 'triangles', header, rows));
  return es.apply(label) ? list.length : 0;
}

/** Swaps id2/id3 of selected triangle rows (flips the normal). */
export function flipTris(idx: Iterable<number>): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const es = new EditSet();
  const done = new Set<ANode>();
  for (const i of idx) {
    const t = v.tris[i];
    if (!t || done.has(t.row.src.node)) continue;
    done.add(t.row.src.node);
    if (!writableDoc(t.row.src.file)) return false;
    const row = t.row.src.node as AArr;
    const header = headerOf(t.row.src.table, 'triangles');
    const c2 = row.items[header.indexOf('id2:')], c3 = row.items[header.indexOf('id3:')];
    if (!c2 || !c3) continue;
    const txt = docText(t.row.src.file);
    es.add(t.row.src.file, [
      { s: c2.s, e: c2.e, text: txt.slice(c3.s, c3.e) },
      { s: c3.s, e: c3.e, text: txt.slice(c2.s, c2.e) },
    ]);
  }
  return es.apply('Flip triangles');
}

// ------------------------------------------------------------------------------------------
// delete
// ------------------------------------------------------------------------------------------

export function deleteSelection(): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const si = resolveSel(v, useSel.getState().sel);
  const rows = new Map<string, Set<ANode>>();
  const add = (r: Row) => {
    let s = rows.get(r.src.file);
    if (!s) rows.set(r.src.file, (s = new Set()));
    s.add(r.src.node);
  };
  const related = settings().deleteRelated;
  for (const i of si.nodes) {
    add(v.nodes[i].row);
    if (related) {
      v.beams.forEach((b) => (si.nodes.has(b.a) || si.nodes.has(b.b)) && add(b.row));
      v.tris.forEach((t) => (si.nodes.has(t.a) || si.nodes.has(t.b) || si.nodes.has(t.c)) && add(t.row));
    }
  }
  for (const i of si.beams) add(v.beams[i].row);
  for (const i of si.tris) add(v.tris[i].row);
  for (const i of si.flex) add(v.flexbodies[i].row);
  for (const i of si.props) add(v.props[i].row);
  const trig = v.triggers;
  for (const i of si.triggers) if (trig[i]) add(trig[i]);
  if (!rows.size) return false;
  const es = new EditSet();
  let n = 0;
  for (const [file, set] of rows) {
    const d = writableDoc(file);
    if (!d) return false;
    n += set.size;
    es.add(file, deleteNodes(d.text, [...set]));
  }
  const ok = es.apply(`Delete ${n} row(s)`);
  if (ok) setSel(emptySel());
  return ok;
}

// ------------------------------------------------------------------------------------------
// mirror / duplicate / naming helpers
// ------------------------------------------------------------------------------------------

/** l <-> r name swap following the configured suffixes (also ll <-> rr). */
export function mirrorName(name: string): string | null {
  const s = settings();
  const L = s.mirrorSuffixLeft, R = s.mirrorSuffixRight;
  const m = new RegExp(`^(.*?)(${escape(L)}+|${escape(R)}+)$`).exec(name);
  if (!m || !m[1]) return null;
  const suf = m[2];
  const swapped = suf.startsWith(L) ? R.repeat(suf.length / L.length) : L.repeat(suf.length / R.length);
  return m[1] + swapped;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mirrors selected nodes (and beams/tris between them) across X=0, creating or moving counterparts. */
export function mirrorSelection(): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const si = resolveSel(v, useSel.getState().sel);
  const nodes = new Set(si.nodes);
  for (const i of si.beams) {
    nodes.add(v.beams[i].a);
    nodes.add(v.beams[i].b);
  }
  for (const i of si.tris) {
    nodes.add(v.tris[i].a);
    nodes.add(v.tris[i].b);
    nodes.add(v.tris[i].c);
  }
  const tol = settings().mirrorTolerance;
  const nameMap = new Map<string, string>();
  const moves = new Map<number, [number, number, number]>();
  const creates: Array<{ name: string; x: number; y: number; z: number; src: number }> = [];
  for (const i of nodes) {
    const n = v.nodes[i];
    if (Math.abs(n.x) <= tol) {
      nameMap.set(n.name, n.name);
      continue;
    }
    const mn = mirrorName(n.name);
    if (!mn) {
      toast('warn', `"${n.name}" has no ${settings().mirrorSuffixLeft}/${settings().mirrorSuffixRight} suffix — skipped`);
      continue;
    }
    nameMap.set(n.name, mn);
    const j = v.nodeIndex.get(mn);
    if (j !== undefined) {
      if (!nodes.has(j)) {
        const m = v.nodes[j];
        if (Math.abs(m.x + n.x) > 1e-6 || Math.abs(m.y - n.y) > 1e-6 || Math.abs(m.z - n.z) > 1e-6) moves.set(j, [-n.x, n.y, n.z]);
      }
    } else {
      creates.push({ name: mn, x: -n.x, y: n.y, z: n.z, src: i });
    }
  }
  let did = false;
  if (moves.size) did = moveNodes(moves, 'Mirror nodes') || did;
  if (creates.length) {
    // create in the source node's part when it is writable
    const byPart = new Map<string, typeof creates>();
    for (const c of creates) {
      const p = v.nodes[c.src].row.part.def;
      const k = p.file + '|' + p.name;
      let l = byPart.get(k);
      if (!l) byPart.set(k, (l = []));
      l.push(c);
    }
    const prev = useWs.getState().target;
    for (const [k, list] of byPart) {
      const [file, part] = k.split('|');
      useWs.setState({ target: { doc: file, part } });
      const opts = (c: (typeof creates)[0]) => nodeExtraOpts(v.nodes[c.src].row);
      did = addNodes(list.map((c) => ({ name: c.name, x: c.x, y: c.y, z: c.z, opts: opts(c) })), 'Mirror nodes').length > 0 || did;
    }
    useWs.setState({ target: prev });
  }
  // beams / tris
  const v2 = ws.vehicle!;
  const beams: Array<[string, string]> = [];
  for (const i of si.beams) {
    const b = v.beams[i];
    const a = nameMap.get(v.nodes[b.a].name), c = nameMap.get(v.nodes[b.b].name);
    if (a && c) beams.push([a, c]);
  }
  if (beams.length) did = addBeams(beams.filter(([a, b]) => !hasBeam(v2, v2.nodeIndex.get(a) ?? -1, v2.nodeIndex.get(b) ?? -1)), undefined, 'Mirror beams') > 0 || did;
  const tris: Array<[string, string, string]> = [];
  for (const i of si.tris) {
    const t = v.tris[i];
    const a = nameMap.get(v.nodes[t.a].name), b = nameMap.get(v.nodes[t.b].name), c = nameMap.get(v.nodes[t.c].name);
    // mirrored triangles keep outward normals by reversing the winding
    if (a && b && c) tris.push([a, c, b]);
  }
  if (tris.length) did = addTris(tris, 'Mirror triangles') > 0 || did;
  if (!did) toast('info', 'Nothing to mirror (counterparts already symmetric)');
  return did;
}

/** Row options that should follow a copied node (only literal inline options). */
function nodeExtraOpts(row: Row): Record<string, any> | undefined {
  const r = row.src.node as AArr;
  const header = headerOf(row.src.table, 'nodes');
  const dict = r.items[header.length];
  if (dict && dict.k === 'obj') {
    const out: Record<string, any> = {};
    const txt = docText(row.src.file);
    dict.keys.forEach((k, i) => {
      try {
        out[k.v] = JSON.parse(txt.slice(dict.vals[i].s, dict.vals[i].e));
      } catch {
        /* expressions etc. are not copied */
      }
    });
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

export function duplicateNodes(indices: number[], offset: [number, number, number]): string[] {
  const v = ws.vehicle;
  if (!v || !indices.length) return [];
  const taken = new Set(v.nodeIndex.keys());
  const map = new Map<number, string>();
  const nodes = indices.map((i) => {
    const n = v.nodes[i];
    let name = nextName(n.name, taken);
    taken.add(name);
    map.set(i, name);
    return { name, x: n.x + offset[0], y: n.y + offset[1], z: n.z + offset[2], opts: nodeExtraOpts(n.row) };
  });
  const names = addNodes(nodes, 'Duplicate nodes');
  if (!names.length) return [];
  const set = new Set(indices);
  const pairs: Array<[string, string]> = [];
  for (const b of v.beams) if (set.has(b.a) && set.has(b.b)) pairs.push([map.get(b.a)!, map.get(b.b)!]);
  if (pairs.length) addBeams(pairs, undefined, 'Duplicate beams');
  return names;
}

export function nextName(base: string, taken: Set<string>): string {
  const m = /^(.*?)(\d+)([a-z]*)$/i.exec(base);
  if (m) {
    for (let n = +m[2] + 1; n < +m[2] + 10000; n++) {
      const c = m[1] + n + m[3];
      if (!taken.has(c)) return c;
    }
  }
  for (let n = 2; n < 100000; n++) if (!taken.has(base + '_' + n)) return base + '_' + n;
  return base + '_copy';
}

/** Name with side suffix from the node's X position. */
export function sidedName(prefix: string, num: number, x: number): string {
  const s = settings();
  const side = x > s.namingCenterTolerance ? s.mirrorSuffixLeft : x < -s.namingCenterTolerance ? s.mirrorSuffixRight : '';
  return prefix + num + side;
}

// ------------------------------------------------------------------------------------------
// options / generic rows
// ------------------------------------------------------------------------------------------

export function setRowOptionFor(row: Row, key: string, value: any): boolean {
  const d = writableDoc(row.src.file);
  if (!d) return false;
  const header = headerOf(row.src.table, row.src.section);
  const es = new EditSet();
  es.add(d.key, setRowOption(d.text, row.src.node as AArr, header.length, key, value, dec()));
  return es.apply(`Set ${key}`);
}

/** Replaces one header cell value of a row (e.g. a prop translation, a trigger size). */
export function setRowCell(row: Row, col: string, value: any): boolean {
  const d = writableDoc(row.src.file);
  if (!d) return false;
  const header = headerOf(row.src.table, row.src.section);
  const i = header.indexOf(col);
  const r = row.src.node as AArr;
  if (i < 0) return setRowOptionFor(row, col, value);
  const cell = r.items[i];
  const es = new EditSet();
  if (cell) es.add(d.key, [{ s: cell.s, e: cell.e, text: fmtValue(value, dec()) }]);
  else return false;
  return es.apply(`Set ${col}`);
}

/** Inserts arbitrary rows into a section of a given part. */
export function insertSectionRows(doc: Doc, part: PartDef, section: string, recs: Array<Record<string, any>>, header?: string[], label = 'Insert rows'): boolean {
  if (!writableDoc(doc.key)) return false;
  const h = header ?? headerOf(part.sections.get(section), section);
  const rows = recs.map((r) => fmtRow(rowFromRecord(h, r), dec()));
  const es = new EditSet();
  es.add(doc.key, insertRows(doc.text, part, section, h, rows));
  return es.apply(label);
}

/** Inserts raw preformatted rows (already matching the section header). */
export function insertRawRows(doc: Doc, part: PartDef, section: string, header: string[], rows: string[], label = 'Insert rows'): boolean {
  if (!writableDoc(doc.key)) return false;
  const es = new EditSet();
  es.add(doc.key, insertRows(doc.text, part, section, header, rows));
  return es.apply(label);
}

export function applyRaw(label: string, edits: Map<string, TextEdit[]>): boolean {
  for (const k of edits.keys()) if (!writableDoc(k)) return false;
  return ws.applyEdits(label, edits);
}

export function selectNodesByName(names: string[]) {
  const s = emptySel();
  for (const n of names) s.nodes.add(n);
  setSel(s);
}

export { EditSet };

// ------------------------------------------------------------------------------------------
// symmetry (X mirror) and rails
// ------------------------------------------------------------------------------------------

function symTol(): number {
  return Math.max(settings().mirrorTolerance, 0.002);
}

/** Mirror twin of a node: by l/r name when that node exists, else by mirrored position. Centre nodes are their own twin. */
export function twinOf(v: Vehicle, i: number): number | null {
  const n = v.nodes[i];
  const tol = symTol();
  if (Math.abs(n.x) <= tol) return i;
  const mn = mirrorName(n.name);
  if (mn) {
    const j = v.nodeIndex.get(mn);
    if (j !== undefined) return j;
  }
  let best = -1, bd = Math.max(tol * 3, 0.005);
  v.nodes.forEach((m, j) => {
    if (j === i) return;
    const d = Math.hypot(m.x + n.x, m.y - n.y, m.z - n.z);
    if (d < bd) {
      bd = d;
      best = j;
    }
  });
  return best >= 0 ? best : null;
}

export interface SymmetryResult {
  /** moved nodes + their mirrored twins */
  all: Map<number, [number, number, number]>;
  /** twins that live in another part than the node that moved them */
  cross: Array<{ idx: number; name: string; part: string; from: string; fromPart: string }>;
}

/** Adds mirrored twins (−x, y, z) to a set of node moves. Centre-line nodes stay on the centre line. */
export function withSymmetry(v: Vehicle, changes: Map<number, [number, number, number]>): SymmetryResult {
  const all = new Map(changes);
  const cross: SymmetryResult['cross'] = [];
  for (const [i, p] of changes) {
    const t = twinOf(v, i);
    if (t === null) continue;
    if (t === i) {
      all.set(i, [0, p[1], p[2]]);
      continue;
    }
    if (changes.has(t)) continue;
    all.set(t, [-p[0], p[1], p[2]]);
    const a = v.nodes[i].row.part.def.name, b = v.nodes[t].row.part.def.name;
    if (a !== b) cross.push({ idx: t, name: v.nodes[t].name, part: b, from: v.nodes[i].name, fromPart: a });
  }
  return { all, cross };
}

/** session answer to "also move twins in other parts?" */
let crossPolicy: 'ask' | 'both' | 'own' = 'ask';
export function setSymmetryCrossPolicy(p: 'ask' | 'both' | 'own') {
  crossPolicy = p;
}

/** Twin moves for previews (cross-part twins included unless the session said "only this side"). */
export function symmetryPreview(changes: Map<number, [number, number, number]>): Map<number, [number, number, number]> {
  const v = ws.vehicle;
  if (!v || !settings().symmetryX) return changes;
  const r = withSymmetry(v, changes);
  if (crossPolicy === 'own') for (const c of r.cross) r.all.delete(c.idx);
  return r.all;
}

/**
 * Moves nodes, adding mirrored twins when symmetry is on. Twins in other parts ask first;
 * returns 'pending' while that dialog is open (the dialog commits or cancels).
 */
export function moveNodesSym(changes: Map<number, [number, number, number]>, label = 'Move nodes', onCancel?: () => void): boolean | 'pending' {
  const v = ws.vehicle;
  if (!v) return false;
  if (!settings().symmetryX) return moveNodes(changes, label);
  const r = withSymmetry(v, changes);
  if (r.cross.length && crossPolicy === 'ask') {
    useUi.setState({ dialog: { kind: 'symmetryCross', data: { result: r, own: changes, label, onCancel } } });
    return 'pending';
  }
  if (r.cross.length && crossPolicy === 'own') for (const c of r.cross) r.all.delete(c.idx);
  return moveNodes(r.all, label + (r.all.size > changes.size ? ' (symmetry)' : ''));
}

/** Moves slidenodes onto the closest point of their rail. */
export function snapToRails(nodes: number[]): number {
  const v = ws.vehicle;
  if (!v) return 0;
  const rails = collectRails(v);
  const slides = new Map(collectSlides(v).map((s) => [s.node, s]));
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  const ch = new Map<number, [number, number, number]>();
  let notSlide = 0;
  for (const i of nodes) {
    const sl = slides.get(i);
    const r = sl && rails.get(sl.rail);
    if (!r) {
      notSlide++;
      continue;
    }
    const c = closestOnRail(railPoints(r, pos), r.looped, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    if (c && c.dist > 1e-5) ch.set(i, c.point);
  }
  if (!ch.size) {
    toast('info', notSlide === nodes.length ? 'No slidenode with a known rail selected' : 'Already on their rails');
    return 0;
  }
  return moveNodes(ch, 'Snap to rail') ? ch.size : 0;
}

/** Creates a rail through nodes (in order) in the target part. */
export function addRail(name: string, nodes: string[], looped: boolean, capped: boolean): boolean {
  const t = requireTarget();
  if (!t) return false;
  name = name.trim();
  if (!name) return false;
  if (nodes.length < 2) {
    toast('warn', 'A rail needs at least 2 nodes');
    return false;
  }
  if (ws.vehicle && collectRails(ws.vehicle).has(name)) {
    toast('warn', `Rail "${name}" already exists`);
    return false;
  }
  const value = `{"links:":[${nodes.map((n) => JSON.stringify(n)).join(', ')}], "broken:":[], "looped":${looped}, "capped":${capped}}`;
  const sec = t.part.sections.get('rails');
  const es = new EditSet();
  if (sec && sec.k === 'obj') es.add(t.doc.key, insertKey(t.doc.text, sec, name, () => value));
  else {
    const eol = eolOf(t.doc.text), unit = indentUnitOf(t.doc.text);
    es.add(t.doc.key, insertKey(t.doc.text, t.part.node, 'rails', (ind) => `{${eol}${ind}${unit}${JSON.stringify(name)}: ${value},${eol}${ind}}`));
  }
  return es.apply(`Add rail ${name}`);
}

const SLIDE_HEADER = ['id:', 'railName', 'attached', 'fixToRail', 'tolerance', 'spring', 'strength', 'capStrength'];

/** Makes nodes slidenodes on a rail (vanilla defaults), optionally snapping them on it. */
export function addSlidenodes(nodes: string[], rail: string, snap: boolean, spring = 800100): boolean {
  const t = requireTarget();
  if (!t || !nodes.length) return false;
  const v = ws.vehicle;
  const existing = new Set(v ? collectSlides(v).map((s) => v.nodes[s.node].name) : []);
  const fresh = nodes.filter((n) => !existing.has(n));
  if (!fresh.length) {
    toast('info', 'Those nodes are already slidenodes');
    return false;
  }
  const sec = t.part.sections.get('slidenodes');
  const header = sec ? headerOf(sec, 'slidenodes') : SLIDE_HEADER;
  const rows = fresh.map((n) =>
    fmtRow(rowFromRecord(header, { 'id:': n, railName: rail, attached: true, fixToRail: true, tolerance: 0, spring, strength: 'FLT_MAX', capStrength: 'FLT_MAX' }), dec()),
  );
  const es = new EditSet();
  es.add(t.doc.key, insertRows(t.doc.text, t.part, 'slidenodes', header, rows));
  if (!es.apply(`Add ${fresh.length} slidenode(s) on ${rail}`)) return false;
  if (snap && ws.vehicle) {
    const w = ws.vehicle;
    snapToRails(fresh.map((n) => w.nodeIndex.get(n)).filter((x): x is number => x !== undefined));
  }
  return true;
}

/** Writes new values (header cells or options) into trigger rows, one undo step. */
export function setTriggerValues(changes: Map<number, Record<string, any>>, label = 'Transform triggers'): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const es = new EditSet();
  for (const [idx, vals] of changes) {
    const row = v.triggers[idx];
    if (!row) continue;
    const d = writableDoc(row.src.file);
    if (!d) return false;
    const header = headerOf(row.src.table, row.src.section);
    const r = row.src.node as AArr;
    for (const [k, val] of Object.entries(vals)) {
      const i = header.indexOf(k);
      const cell = i >= 0 ? r.items[i] : undefined;
      if (cell) es.add(d.key, [{ s: cell.s, e: cell.e, text: fmtValue(val, dec()) }]);
      else es.add(d.key, setRowOption(d.text, r, header.length, k, val, dec()));
    }
  }
  return es.apply(label);
}

// ------------------------------------------------------------------------------------------
// triggers: duplicate, mirror, convert to global
// ------------------------------------------------------------------------------------------

function triggerPlacement(idx: number) {
  const v = ws.vehicle;
  if (!v) return null;
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  const t = placeTriggers(v, pos).find((x) => x.idx === idx);
  return t ? { v, pos, t } : null;
}

function uniqueTriggerId(v: Vehicle, base: string): string {
  const taken = new Set(v.triggers.map((r) => String(r.v.id ?? '')));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + '_' + i)) i++;
  return base + '_' + i;
}

/** Copies a trigger row right below itself with a unique id. */
export function duplicateTrigger(idx: number): boolean {
  const v = ws.vehicle;
  const row = v?.triggers[idx];
  if (!v || !row) return false;
  const d = writableDoc(row.src.file);
  if (!d) return false;
  const header = headerOf(row.src.table, row.src.section);
  const text = d.text.slice(row.src.node.s, row.src.node.e);
  const id = String(row.v.id ?? 'trigger');
  const copy = header.includes('id') ? setRowCellsText(text, header, { id: uniqueTriggerId(v, id) }, dec()) : text;
  const es = new EditSet();
  es.add(d.key, insertRowsAfter(d.text, row.src.node, [copy]));
  return es.apply('Duplicate trigger');
}

/** Adds the X-mirror of a trigger (side tokens in id and node names swapped, box reflected). */
export function mirrorTrigger(idx: number): boolean {
  const pl = triggerPlacement(idx);
  if (!pl) return false;
  const { v, pos, t } = pl;
  const row = t.row;
  const d = writableDoc(row.src.file);
  if (!d) return false;
  const header = headerOf(row.src.table, row.src.section);
  const sw = (n: any) => (typeof n === 'string' ? mirrorName(n) ?? n : n);
  const nodes = { ref: sw(row.v['idRef:']), x: sw(row.v['idX:']), y: sw(row.v['idY:']) };
  const toRaw = (q: [number, number, number]): [number, number, number] => {
    const r = invertNodeXform(getNodeXform(row.v), q[0], q[1], q[2]);
    return [r.x, r.y, r.z];
  };
  const vals = mirroredTriggerValues(v, pos, t, nodes, toRaw);
  if (!vals) {
    toast('warn', `Mirror nodes not found (${nodes.ref}, ${nodes.x}, ${nodes.y})`);
    return false;
  }
  const id = String(row.v.id ?? 'trigger');
  const mid = swapSideTokens(id);
  vals.id = uniqueTriggerId(v, mid !== id ? mid : id + '_mirror');
  vals['idRef:'] = nodes.ref;
  vals['idX:'] = nodes.x;
  vals['idY:'] = nodes.y;
  const text = setRowCellsText(d.text.slice(row.src.node.s, row.src.node.e), header, vals, dec());
  const es = new EditSet();
  es.add(d.key, insertRowsAfter(d.text, row.src.node, [text]));
  const ok = es.apply('Mirror trigger');
  if (ok) toast('info', `Added ${vals.id}. Link its actions in triggerEventLinks2 if they differ per side.`);
  return ok;
}

/** Rewrites a node-relative trigger position as baseTranslationGlobal (same place in game). */
export function triggerToGlobal(idx: number): boolean {
  const pl = triggerPlacement(idx);
  if (!pl) return false;
  const r = pl.t.row;
  const raw = invertNodeXform(getNodeXform(r.v), pl.t.origin[0], pl.t.origin[1], pl.t.origin[2]);
  return setRowOptionFor(r, 'baseTranslationGlobal', { x: +raw.x.toFixed(4), y: +raw.y.toFixed(4), z: +raw.z.toFixed(4) });
}
