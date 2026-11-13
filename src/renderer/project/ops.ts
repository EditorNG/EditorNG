/**
 * Editing operations used by the 3D tools. Each produces minimal text edits.
 */
import { ws, useWs, type Doc } from './workspace';
import {
  DEFAULT_HEADERS, deleteNodes, fmtNum, fmtRow, fmtValue, insertRows, rowFromRecord, setRowOption, findNodeTokens, insertKey, eolOf, indentUnitOf, insertRowsAfter, setRowCellsText, indentAt, insertRowsAtLine, type TextEdit,
} from '@core/jbeam/edit';
import { insertMarkOffset, moveInsertMark } from '../editor/insertMark';
import { getNodeXform, invertNodeXform } from '@core/jbeam/nodeTransform';
import type { ANode, AArr } from '@core/sjson';
import type { ActivePart, PartDef, Row, Vehicle } from '@core/jbeam/types';
import { settings } from '../state/settings';
import { useUi } from '../state/ui';
import { collectRails, collectSlides, closestOnRail, railPoints } from '@core/jbeam/rails';
import { placeTriggers, mirroredTriggerValues, worldAlignedAxes, triggerValues } from '@core/jbeam/triggers';
import { swapSideTokens } from '@core/jbeam/mirror';
import { toast } from '../state/toast';
import { useSel, emptySel, beamKey, triKey, cloneSel, resolveSel, setSel } from '../state/selection';

/**
 * Like insertRows, but when the code insertion point (the user's last click in the code editor) is inside
 * that section of that part, the rows go right below it; consecutive additions follow each other there.
 * Otherwise the rows are appended at the end of the section.
 */
export function insertRowsHere(text: string, part: PartDef, section: string, header: string[], rows: string[]): TextEdit[] {
  const m = ws.doc(part.file)?.model;
  const cur = m && !m.isDisposed() && m.getValueLength() === text.length ? insertMarkOffset(m) : null;
  if (m && cur != null) {
    const r = insertRowsAtLine(text, part, section, rows, cur);
    if (r) {
      moveInsertMark(m, r.at);
      return r.edits;
    }
  }
  return insertRows(text, part, section, header, rows);
}

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
// symmetry for edits (X mirror): with Symmetry on, creating / deleting / renaming / editing
// also applies to the mirror twin. Explicit mirror commands run without it.
// ------------------------------------------------------------------------------------------

type Target = { doc: Doc; part: PartDef; active?: ActivePart };
let symOff = 0;

function symOn(): boolean {
  return settings().symmetryX && symOff === 0 && !!ws.vehicle;
}

/** Runs an edit with symmetry suspended (explicit mirror ops, and the twin half of a symmetric edit). */
export function withoutSymmetry<T>(fn: () => T): T {
  symOff++;
  try {
    return fn();
  } finally {
    symOff--;
  }
}

/** Where mirrored rows go: the other-side part (door_FL → door_FR) when it is loaded and editable, else the same part. */
function twinTarget(t: Target): Target {
  const name = swapSideTokens(t.part.name);
  if (name !== t.part.name) {
    const ap = ws.vehicle?.partsByName.get(name);
    const d = ap ? ws.doc(ap.def.file) : undefined;
    const p = d?.jfile?.parts.find((x) => x.name === name);
    if (ap && d && p && d.writable && !d.isCommon) return { doc: d, part: p, active: ap };
  }
  return t;
}

/** Name of a node's twin (existing node), or null for centre-line / unmatched nodes. */
function twinName(v: Vehicle, name: string): string | null {
  const i = v.nodeIndex.get(name);
  if (i === undefined) return null;
  const t = twinOf(v, i);
  return t === null || t === i ? null : v.nodes[t].name;
}

/** Twin of a beam (the beam between the twins of its nodes). */
function twinBeam(v: Vehicle, bi: number): number | null {
  const b = v.beams[bi];
  const ta = twinOf(v, b.a), tb = twinOf(v, b.b);
  if (ta === null || tb === null) return null;
  const j = v.beams.findIndex((x) => (x.a === ta && x.b === tb) || (x.a === tb && x.b === ta));
  return j >= 0 && j !== bi ? j : null;
}

function twinTri(v: Vehicle, ti: number): number | null {
  const t = v.tris[ti];
  const tw = [twinOf(v, t.a), twinOf(v, t.b), twinOf(v, t.c)];
  if (tw.some((x) => x === null)) return null;
  const want = new Set(tw as number[]);
  const j = v.tris.findIndex((x) => want.has(x.a) && want.has(x.b) && want.has(x.c));
  return j >= 0 && j !== ti ? j : null;
}

/** Twin of a trigger: the one with the side-swapped id, else the one on the mirrored nodes. */
function twinTrigger(v: Vehicle, idx: number): number | null {
  const r = v.triggers[idx];
  if (!r) return null;
  const id = String(r.v.id ?? '');
  const mid = swapSideTokens(id);
  if (mid !== id) {
    const j = v.triggers.findIndex((x, k) => k !== idx && String(x.v.id ?? '') === mid);
    if (j >= 0) return j;
  }
  const m = (k: string) => (typeof r.v[k] === 'string' ? mirrorName(r.v[k]) : null);
  const ref = m('idRef:'), x = m('idX:'), y = m('idY:');
  if (!ref || !x || !y) return null;
  const j = v.triggers.findIndex((t, k) => k !== idx && t.v['idRef:'] === ref && t.v['idX:'] === x && t.v['idY:'] === y);
  return j >= 0 ? j : null;
}

/** Side tokens swapped in string option values (group "door_L" → "door_R"). */
function mirrorOpts(opts: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!opts) return opts;
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(opts)) out[k] = typeof val === 'string' ? swapSideTokens(val) : Array.isArray(val) ? val.map((x) => (typeof x === 'string' ? swapSideTokens(x) : x)) : val;
  return out;
}

/** Rows of the twins of node / beam / triangle rows (writable ones only). */
function twinRows(v: Vehicle, rows: Row[]): Row[] {
  const have = new Set(rows.map((r) => r.src.node));
  const out: Row[] = [];
  const add = (r: Row | undefined) => {
    if (!r || have.has(r.src.node) || !ws.doc(r.src.file)?.writable) return;
    have.add(r.src.node);
    out.push(r);
  };
  const want = new Set(rows.map((r) => r.src.node));
  v.nodes.forEach((n, i) => {
    if (!want.has(n.row.src.node)) return;
    const t = twinOf(v, i);
    if (t !== null && t !== i) add(v.nodes[t].row);
  });
  v.beams.forEach((b, i) => {
    if (!want.has(b.row.src.node)) return;
    const t = twinBeam(v, i);
    if (t !== null) add(v.beams[t].row);
  });
  v.tris.forEach((x, i) => {
    if (!want.has(x.row.src.node)) return;
    const t = twinTri(v, i);
    if (t !== null) add(v.tris[t].row);
  });
  return out;
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
  // symmetry: a twin at −x for every off-centre node (l/r name swapped) unless it already exists
  const twins = new Map<number, { name: string; x: number; y: number; z: number; opts?: Record<string, any> }>();
  if (symOn() && v) {
    const tol = symTol();
    const batch = new Set(nodes.map((n) => n.name));
    let unnamed = 0;
    nodes.forEach((n, k) => {
      if (Math.abs(n.x) <= tol) return;
      const name = mirrorName(n.name);
      if (!name) return void unnamed++;
      if (batch.has(name) || v.nodeIndex.has(name)) return;
      if (v.nodes.some((m) => Math.hypot(m.x + n.x, m.y - n.y, m.z - n.z) <= tol)) return;
      batch.add(name);
      twins.set(k, { name, x: -n.x, y: n.y, z: n.z, opts: mirrorOpts(n.opts) });
    });
    if (unnamed) toast('info', `Symmetry: ${unnamed} node(s) have no l/r suffix, so no twin was made`);
  }
  const rowsFor = (tg: Target, list: typeof nodes) => {
    const header = headerOf(tg.part.sections.get('nodes'), 'nodes');
    const xf = getNodeXform(tg.active?.slotOptions ?? {});
    return {
      header,
      rows: list.map((n) => {
        const raw = invertNodeXform(xf, n.x, n.y, n.z);
        const rec: Record<string, any> = { id: n.name, posX: round(raw.x), posY: round(raw.y), posZ: round(raw.z), ...(n.opts ?? {}) };
        return fmtRow(rowFromRecord(header, rec), dec());
      }),
    };
  };
  const es = new EditSet();
  const tt = twins.size ? twinTarget(t) : t;
  if (tt === t) {
    // same part: each twin right after its node
    const list = nodes.flatMap((n, k) => (twins.has(k) ? [n, twins.get(k)!] : [n]));
    const r = rowsFor(t, list);
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'nodes', r.header, r.rows));
  } else {
    const a = rowsFor(t, nodes), b = rowsFor(tt, [...twins.values()]);
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'nodes', a.header, a.rows));
    es.add(tt.doc.key, insertRowsHere(tt.doc.text, tt.part, 'nodes', b.header, b.rows));
  }
  if (!es.apply(twins.size ? label + ' (symmetry)' : label)) return [];
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
  if (symOn()) {
    // the twin follows: b5l → x5l renames b5r → x5r too
    const tOld = twinName(v, oldName), tNew = mirrorName(newName);
    if (tOld && tNew && tNew !== newName && !v.nodeIndex.has(tNew) && ws.doc(v.nodes[v.nodeIndex.get(tOld)!].row.src.file)?.writable) {
      return ws.group(`Rename ${oldName} → ${newName} (symmetry)`, () => withoutSymmetry(() => renameNode(oldName, newName) && (renameNode(tOld, tNew), true)));
    }
  }
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
  // symmetry: the beam between the twins of its nodes
  const twins = new Map<number, [string, string]>();
  if (symOn()) {
    list.forEach(([a, b], k) => {
      const ta = twinName(v, a) ?? (Math.abs(v.nodes[v.nodeIndex.get(a)!].x) <= symTol() ? a : null);
      const tb = twinName(v, b) ?? (Math.abs(v.nodes[v.nodeIndex.get(b)!].x) <= symTol() ? b : null);
      if (!ta || !tb || ta === tb) return;
      const key = beamKey(ta, tb);
      if (seen.has(key) || hasBeam(v, v.nodeIndex.get(ta)!, v.nodeIndex.get(tb)!)) return;
      seen.add(key);
      twins.set(k, [ta, tb]);
    });
  }
  const rowsFor = (tg: Target, pairs: Array<[string, string]>, o?: Record<string, any>) => {
    const header = headerOf(tg.part.sections.get('beams'), 'beams');
    return { header, rows: pairs.map(([a, b]) => fmtRow(rowFromRecord(header, { 'id1:': a, 'id2:': b, ...(o ?? {}) }), dec())) };
  };
  const es = new EditSet();
  const tt = twins.size ? twinTarget(t) : t;
  if (tt === t) {
    const r = rowsFor(t, list.flatMap((p, k) => (twins.has(k) ? [p, twins.get(k)!] : [p])), opts);
    // twin rows get side-swapped options; rebuild those rows individually
    if (opts && twins.size) {
      const mo = mirrorOpts(opts);
      let j = 0;
      list.forEach((p, k) => {
        j++;
        if (twins.has(k)) r.rows[j++] = rowsFor(t, [twins.get(k)!], mo).rows[0];
      });
    }
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'beams', r.header, r.rows));
  } else {
    const a = rowsFor(t, list, opts), b = rowsFor(tt, [...twins.values()], mirrorOpts(opts));
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'beams', a.header, a.rows));
    es.add(tt.doc.key, insertRowsHere(tt.doc.text, tt.part, 'beams', b.header, b.rows));
  }
  return es.apply(twins.size ? label + ' (symmetry)' : label) ? list.length : 0;
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
  // symmetry: the twin triangle, winding reversed so its normal mirrors too
  const twins = new Map<number, [string, string, string]>();
  if (symOn()) {
    const seen = new Set(list.map((x) => triKey(...x)));
    const tn = (n: string) => twinName(v, n) ?? (Math.abs(v.nodes[v.nodeIndex.get(n)!].x) <= symTol() ? n : null);
    list.forEach(([a, b, c], k) => {
      const ta = tn(a), tb = tn(b), tc = tn(c);
      if (!ta || !tb || !tc || new Set([ta, tb, tc]).size < 3) return;
      const key = triKey(ta, tc, tb);
      if (seen.has(key) || existing.has(key)) return;
      seen.add(key);
      twins.set(k, [ta, tc, tb]);
    });
  }
  const rowsFor = (tg: Target, l: Array<[string, string, string]>) => {
    const header = headerOf(tg.part.sections.get('triangles'), 'triangles');
    return { header, rows: l.map(([a, b, c]) => fmtRow(rowFromRecord(header, { 'id1:': a, 'id2:': b, 'id3:': c }), dec())) };
  };
  const es = new EditSet();
  const tt = twins.size ? twinTarget(t) : t;
  if (tt === t) {
    const r = rowsFor(t, list.flatMap((x, k) => (twins.has(k) ? [x, twins.get(k)!] : [x])));
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'triangles', r.header, r.rows));
  } else {
    const a = rowsFor(t, list), b = rowsFor(tt, [...twins.values()]);
    es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'triangles', a.header, a.rows));
    es.add(tt.doc.key, insertRowsHere(tt.doc.text, tt.part, 'triangles', b.header, b.rows));
  }
  return es.apply(twins.size ? label + ' (symmetry)' : label) ? list.length : 0;
}

/** Swaps id2/id3 of selected triangle rows (flips the normal). */
export function flipTris(idx: Iterable<number>): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const es = new EditSet();
  const done = new Set<ANode>();
  const all = new Set(idx);
  if (symOn()) {
    for (const i of [...all]) {
      const t = twinTri(v, i);
      if (t !== null && ws.doc(v.tris[t].row.src.file)?.writable) all.add(t);
    }
  }
  for (const i of all) {
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
  if (symOn()) {
    // the twins go too (only those in editable files)
    const ok = (r: Row) => !!ws.doc(r.src.file)?.writable;
    for (const i of [...si.nodes]) {
      const t = twinOf(v, i);
      if (t !== null && ok(v.nodes[t].row)) si.nodes.add(t);
    }
    for (const i of [...si.beams]) {
      const t = twinBeam(v, i);
      if (t !== null && ok(v.beams[t].row)) si.beams.add(t);
    }
    for (const i of [...si.tris]) {
      const t = twinTri(v, i);
      if (t !== null && ok(v.tris[t].row)) si.tris.add(t);
    }
    for (const i of [...si.triggers]) {
      const t = twinTrigger(v, i);
      if (t !== null && ok(v.triggers[t])) si.triggers.add(t);
    }
  }
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
  return withoutSymmetry(mirrorSelectionImpl);
}
function mirrorSelectionImpl(): boolean {
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
  return ws.group('Duplicate nodes', () => {
    const names = addNodes(nodes, 'Duplicate nodes');
    if (!names.length) return [];
    const set = new Set(indices);
    const pairs: Array<[string, string]> = [];
    for (const b of v.beams) if (set.has(b.a) && set.has(b.b)) pairs.push([map.get(b.a)!, map.get(b.b)!]);
    if (pairs.length) addBeams(pairs, undefined, 'Duplicate beams');
    return names;
  });
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
  es.add(doc.key, insertRowsHere(doc.text, part, section, h, rows));
  return es.apply(label);
}

/** Inserts raw preformatted rows (already matching the section header). */
export function insertRawRows(doc: Doc, part: PartDef, section: string, header: string[], rows: string[], label = 'Insert rows'): boolean {
  if (!writableDoc(doc.key)) return false;
  const es = new EditSet();
  es.add(doc.key, insertRowsHere(doc.text, part, section, header, rows));
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
  es.add(t.doc.key, insertRowsHere(t.doc.text, t.part, 'slidenodes', header, rows));
  if (!es.apply(`Add ${fresh.length} slidenode(s) on ${rail}`)) return false;
  if (snap && ws.vehicle) {
    const w = ws.vehicle;
    snapToRails(fresh.map((n) => w.nodeIndex.get(n)).filter((x): x is number => x !== undefined));
  }
  return true;
}

/** Writes new values (header cells or options) into trigger rows, one undo step. */
export function setTriggerValues(changes: Map<number, Record<string, any>>, label = 'Transform triggers'): boolean {
  const v0 = ws.vehicle;
  if (v0 && symOn()) {
    const pairs: Array<[number, number]> = [];
    for (const i of changes.keys()) {
      const t = twinTrigger(v0, i);
      if (t !== null && !changes.has(t) && ws.doc(v0.triggers[t].src.file)?.writable) pairs.push([i, t]);
    }
    if (pairs.length) {
      return ws.group(label + ' (symmetry)', () =>
        withoutSymmetry(() => {
          if (!setTriggerValues(changes, label)) return false;
          const tw = new Map<number, Record<string, any>>();
          for (const [i, t] of pairs) {
            const vals = mirroredValuesFor(i, t);
            if (vals) tw.set(t, vals);
          }
          if (tw.size) setTriggerValues(tw, label);
          return true;
        }),
      );
    }
  }
  return setTriggerValuesRaw(changes, label);
}

/** Placement values of trigger `src` mirrored across X, expressed on trigger `dst`'s own nodes. */
function mirroredValuesFor(src: number, dst: number): Record<string, any> | null {
  const pl = triggerPlacement(src);
  const row = ws.vehicle?.triggers[dst];
  if (!pl || !row) return null;
  const nodes = { ref: String(row.v['idRef:']), x: String(row.v['idX:']), y: String(row.v['idY:']) };
  const toRaw = (q: [number, number, number]): [number, number, number] => {
    const r = invertNodeXform(getNodeXform(row.v), q[0], q[1], q[2]);
    return [r.x, r.y, r.z];
  };
  const vals = mirroredTriggerValues(pl.v, pl.pos, pl.t, nodes, toRaw);
  if (!vals) return null;
  delete vals.id;
  delete vals['idRef:'];
  delete vals['idX:'];
  delete vals['idY:'];
  return vals;
}

function setTriggerValuesRaw(changes: Map<number, Record<string, any>>, label: string): boolean {
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
  return withoutSymmetry(() => mirrorTriggerImpl(idx));
}
function mirrorTriggerImpl(idx: number): boolean {
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

// ------------------------------------------------------------------------------------------
// selection tools (Blender habits) and node layout
// ------------------------------------------------------------------------------------------

function neighbours(v: Vehicle): Map<number, Array<[number, number]>> {
  const adj = new Map<number, Array<[number, number]>>();
  for (const b of v.beams) {
    const A = v.nodes[b.a], B = v.nodes[b.b];
    const len = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
    (adj.get(b.a) ?? adj.set(b.a, []).get(b.a)!).push([b.b, len]);
    (adj.get(b.b) ?? adj.set(b.b, []).get(b.b)!).push([b.a, len]);
  }
  return adj;
}

/** Shortest path over beams (by length) between two nodes; null when not connected. */
export function shortestPath(v: Vehicle, from: number, to: number, allowed?: (i: number) => boolean): number[] | null {
  const adj = neighbours(v);
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  // binary heap of [dist, node]
  const heap: Array<[number, number]> = [[0, from]];
  const push = (x: [number, number]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, i] = pop();
    if (i === to) break;
    if (d > (dist.get(i) ?? Infinity)) continue;
    for (const [j, w] of adj.get(i) ?? []) {
      if (allowed && !allowed(j) && j !== to) continue;
      const nd = d + w;
      if (nd < (dist.get(j) ?? Infinity)) {
        dist.set(j, nd);
        prev.set(j, i);
        push([nd, j]);
      }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev.get(path[path.length - 1])!);
  return path.reverse();
}

/** Adds (grow) or removes (shrink) one ring of beam neighbours. */
export function growSelection(grow: boolean, visible?: (i: number) => boolean) {
  const v = ws.vehicle;
  if (!v) return;
  const st = useSel.getState();
  const cur = new Set([...st.sel.nodes].map((n) => v.nodeIndex.get(n)).filter((x): x is number => x !== undefined));
  if (!cur.size) return;
  const adj = neighbours(v);
  const next = new Set(cur);
  if (grow) {
    for (const i of cur) for (const [j] of adj.get(i) ?? []) if (!visible || visible(j)) next.add(j);
  } else {
    for (const i of cur) if ((adj.get(i) ?? []).some(([j]) => !cur.has(j) && (!visible || visible(j)))) next.delete(i);
  }
  const s = emptySel();
  for (const i of next) s.nodes.add(v.nodes[i].name);
  setSel(s);
}

/** Beams sharing a property with the given beam (type, deformGroup, breakGroup). */
export function selectSimilarBeams(beamIdx: number, by: 'type' | 'deformGroup' | 'breakGroup', visible?: (i: number) => boolean) {
  const v = ws.vehicle;
  if (!v) return;
  const ref = v.beams[beamIdx];
  const key = (b: (typeof v.beams)[number]) => (by === 'type' ? b.type : String(b.row.v[by] ?? ''));
  const want = key(ref);
  const s = emptySel();
  v.beams.forEach((b, i) => {
    if (key(b) !== want || (visible && !visible(i))) return;
    s.beams.add(beamKey(v.nodes[b.a].name, v.nodes[b.b].name));
  });
  setSel(s);
}

/** Flattens nodes onto one coordinate (the active node's, else the average). */
export function alignNodes(idx: number[], axis: 0 | 1 | 2, toActive: number | null): boolean {
  const v = ws.vehicle;
  if (!v || idx.length < 2) return false;
  const val = toActive !== null ? [v.nodes[toActive].x, v.nodes[toActive].y, v.nodes[toActive].z][axis] : idx.reduce((a, i) => a + [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z][axis], 0) / idx.length;
  const ch = new Map<number, [number, number, number]>();
  for (const i of idx) {
    const p: [number, number, number] = [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z];
    p[axis] = val;
    ch.set(i, p);
  }
  return moveNodesSym(ch, `Align ${'XYZ'[axis]}`) !== false;
}

/** Spaces nodes evenly on the line between the two that are farthest apart (order kept). */
export function distributeNodes(idx: number[]): boolean {
  const v = ws.vehicle;
  if (!v || idx.length < 3) return false;
  const P = (i: number) => [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z];
  let a = idx[0], b = idx[1], best = -1;
  for (const i of idx) for (const j of idx) {
    const d = Math.hypot(P(i)[0] - P(j)[0], P(i)[1] - P(j)[1], P(i)[2] - P(j)[2]);
    if (d > best) {
      best = d;
      a = i;
      b = j;
    }
  }
  const A = P(a), B = P(b);
  const dir = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const l2 = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2 || 1;
  const order = [...idx].sort((i, j) => {
    const ti = ((P(i)[0] - A[0]) * dir[0] + (P(i)[1] - A[1]) * dir[1] + (P(i)[2] - A[2]) * dir[2]) / l2;
    const tj = ((P(j)[0] - A[0]) * dir[0] + (P(j)[1] - A[1]) * dir[1] + (P(j)[2] - A[2]) * dir[2]) / l2;
    return ti - tj;
  });
  const ch = new Map<number, [number, number, number]>();
  order.forEach((i, k) => {
    const t = k / (order.length - 1);
    ch.set(i, [A[0] + dir[0] * t, A[1] + dir[1] * t, A[2] + dir[2] * t]);
  });
  return moveNodesSym(ch, 'Distribute nodes') !== false;
}

/**
 * Merges nodes into one (Blender's merge at active): every reference to the others is rewritten
 * to the target, their rows are deleted, and beams / triangles that collapse are removed.
 */
export function mergeNodes(target: number, others: number[]): boolean {
  const v0 = ws.vehicle;
  if (v0 && symOn()) {
    // the twins merge the same way, when every twin exists and none is already part of this merge
    const tt = twinOf(v0, target);
    const to = others.map((i) => twinOf(v0, i));
    const mine = new Set([target, ...others]);
    if (tt !== null && tt !== target && to.every((x) => x !== null && !mine.has(x))) {
      const names = [v0.nodes[tt].name, ...to.map((x) => v0.nodes[x!].name)];
      return ws.group('Merge nodes (symmetry)', () =>
        withoutSymmetry(() => {
          if (!mergeNodes(target, others)) return false;
          const v1 = ws.vehicle!;
          const idx = names.map((n) => v1.nodeIndex.get(n));
          if (idx.every((x) => x !== undefined)) mergeNodes(idx[0]!, idx.slice(1) as number[]);
          return true;
        }),
      );
    }
  }
  return withoutSymmetry(() => mergeNodesImpl(target, others));
}
function mergeNodesImpl(target: number, others: number[]): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  others = others.filter((i) => i !== target);
  if (!others.length) return false;
  const tName = v.nodes[target].name;
  const oNames = new Set(others.map((i) => v.nodes[i].name));
  const merged = (i: number) => i === target || others.includes(i);
  // rows that disappear: the other nodes, collapsing beams and triangles
  const dead = new Map<string, ANode[]>();
  const kill = (r: Row) => (dead.get(r.src.file.toLowerCase()) ?? dead.set(r.src.file.toLowerCase(), []).get(r.src.file.toLowerCase())!).push(r.src.node);
  for (const i of others) kill(v.nodes[i].row);
  v.beams.forEach((b) => merged(b.a) && merged(b.b) && kill(b.row));
  v.tris.forEach((t) => [t.a, t.b, t.c].filter(merged).length >= 2 && kill(t.row));
  const inDead = (file: string, s: number) => (dead.get(file.toLowerCase()) ?? []).some((n) => s >= n.s && s < n.e);
  const es = new EditSet();
  const readOnly = new Set<string>();
  for (const d of ws.docs.values()) {
    if (!d.jfile || d.isCommon) continue;
    for (const p of d.jfile.parts) {
      for (const name of oNames) {
        const toks = findNodeTokens(p, name).filter((t) => !inDead(d.key, t.s));
        if (!toks.length) continue;
        if (!d.writable) {
          readOnly.add(d.name);
          continue;
        }
        es.add(d.key, toks.map((t) => ({ s: t.s, e: t.e, text: JSON.stringify(tName) })));
      }
    }
  }
  for (const [file, nodes] of dead) {
    const d = writableDoc(file);
    if (!d) return false;
    es.add(d.key, deleteNodes(d.text, nodes));
  }
  if (!es.apply(`Merge ${others.length + 1} nodes into ${tName}`)) return false;
  selectNodesByName([tName]);
  if (readOnly.size) toast('warn', `References in read-only files still use the merged names: ${[...readOnly].join(', ')}`);
  return true;
}

/** Hides nodes in the view (H / Shift+H); Alt+H shows everything again. */
export function hideNodes(names: Iterable<string> | null) {
  if (names === null) {
    useSel.setState({ hidden: new Set() });
    return;
  }
  const h = new Set(useSel.getState().hidden);
  for (const n of names) h.add(n);
  useSel.setState({ hidden: h });
  setSel(emptySel());
}

// ------------------------------------------------------------------------------------------
// batch edit, beam types, property clipboard
// ------------------------------------------------------------------------------------------

/** Writes values into many rows (header cells when the column exists, else inline options), one undo step. */
export function setRowValues(rows: Row[], vals: Record<string, any>, label = 'Edit rows'): boolean {
  const es = new EditSet();
  const v = ws.vehicle;
  const twins = symOn() && v ? twinRows(v, rows) : [];
  const mvals = twins.length ? mirrorOpts(vals)! : vals;
  const isTwin = new Set(twins.map((r) => r.src.node));
  for (const row of [...rows, ...twins]) {
    const d = writableDoc(row.src.file);
    if (!d) return false;
    const header = headerOf(row.src.table, row.src.section);
    const node = row.src.node;
    const text = d.text.slice(node.s, node.e);
    const next = setRowCellsText(text, header, isTwin.has(node) ? mvals : vals, dec());
    if (next !== text) es.add(d.key, [{ s: node.s, e: node.e, text: next }]);
  }
  if (!es.size) return false;
  return es.apply(label);
}

/**
 * Writes values as modifier rows around a contiguous block of rows of one section:
 * {"key": value} before the first row and {"key": ""} (reset) after the last.
 */
export function wrapInModifiers(rows: Row[], vals: Record<string, any>, label = 'Wrap in modifiers'): boolean {
  const block = contiguousBlock(rows);
  if (!block) {
    toast('info', 'The rows are not one contiguous block of one section');
    return false;
  }
  const d = writableDoc(block.file);
  if (!d) return false;
  const eol = eolOf(d.text);
  const ind = indentAt(d.text, block.first.s);
  // close the block by restoring what was in effect before it ("" when nothing was)
  const reset: Record<string, any> = {};
  for (const k of Object.keys(vals)) {
    const before = rows[0].v[k];
    reset[k] = before === undefined ? '' : before;
  }
  const lineStart = d.text.lastIndexOf('\n', block.first.s - 1) + 1;
  const es = new EditSet();
  es.add(d.key, [{ s: lineStart, e: lineStart, text: ind + fmtValue(vals, dec()) + ',' + eol }]);
  es.add(d.key, insertRowsAfter(d.text, block.last, [fmtValue(reset, dec())]));
  return es.apply(label);
}

/** The rows as one uninterrupted run of a table (first/last row nodes), or null. */
export function contiguousBlock(rows: Row[]): null | { file: string; first: ANode; last: ANode } {
  if (!rows.length) return null;
  const t = rows[0].src.table as AArr;
  if (!rows.every((r) => r.src.table === t)) return null;
  const idx = rows.map((r) => t.items.indexOf(r.src.node as any)).sort((a, b) => a - b);
  if (idx[0] < 0) return null;
  for (let i = idx[0]; i <= idx[idx.length - 1]; i++) {
    const it = t.items[i];
    if (it.k === 'arr' && !idx.includes(i)) return null;
  }
  return { file: rows[0].src.file, first: t.items[idx[0]], last: t.items[idx[idx.length - 1]] };
}

export const BEAM_TYPES = ['NORMAL', 'BOUNDED', 'SUPPORT', 'PRESSURED', 'ANISOTROPIC', 'LBEAM', 'HYDRO'] as const;

/** Converts beams to another beamType, adding the fields that type needs (vanilla-typical values). */
export function convertBeams(beamIdx: number[], type: (typeof BEAM_TYPES)[number]): boolean {
  const v = ws.vehicle;
  if (!v || !beamIdx.length) return false;
  if (type === 'HYDRO') {
    toast('info', 'Hydros live in their own "hydros" section; create them there');
    return false;
  }
  const rows: Row[] = [];
  const es = new EditSet();
  const all = new Set(beamIdx);
  if (symOn()) {
    for (const i of beamIdx) {
      const t = twinBeam(v, i);
      if (t !== null && ws.doc(v.beams[t].row.src.file)?.writable) all.add(t);
    }
  }
  for (const i of all) {
    const b = v.beams[i];
    if (b.section !== 'beams') continue;
    const r = b.row.v;
    const vals: Record<string, any> = { beamType: '|' + type };
    const unset = (k: string) => r[k] === undefined || r[k] === '';
    if (type === 'BOUNDED') {
      if (unset('beamLongBound')) vals.beamLongBound = 0.05;
      if (unset('beamShortBound')) vals.beamShortBound = 0.05;
    } else if (type === 'SUPPORT') {
      if (unset('beamLongBound')) vals.beamLongBound = 1;
    } else if (type === 'PRESSURED') {
      if (unset('pressurePSI')) vals.pressurePSI = 30;
      if (unset('surface')) vals.surface = 1;
      if (unset('volumeCoef')) vals.volumeCoef = 1;
    } else if (type === 'ANISOTROPIC') {
      if (unset('springExpansion')) vals.springExpansion = typeof r.beamSpring === 'number' ? r.beamSpring : 4300000;
      if (unset('dampExpansion')) vals.dampExpansion = typeof r.beamDamp === 'number' ? r.beamDamp : 580;
    } else if (type === 'LBEAM' && unset('id3:')) {
      toast('info', 'L-beams need a third node (id3:); add it to the row');
      return false;
    }
    const d = writableDoc(b.row.src.file);
    if (!d) return false;
    const header = headerOf(b.row.src.table, 'beams');
    const text = d.text.slice(b.row.src.node.s, b.row.src.node.e);
    es.add(d.key, [{ s: b.row.src.node.s, e: b.row.src.node.e, text: setRowCellsText(text, header, vals, dec()) }]);
    rows.push(b.row);
  }
  if (!rows.length) {
    toast('info', 'Only rows of a "beams" section can be converted');
    return false;
  }
  return es.apply(`Convert ${rows.length} beam(s) to ${type.toLowerCase()}`);
}

export const BEAM_PROPS = [
  'beamType', 'beamSpring', 'beamDamp', 'beamDeform', 'beamStrength', 'beamPrecompression', 'beamLongBound', 'beamShortBound', 'beamLimitSpring', 'beamLimitDamp',
  'springExpansion', 'dampExpansion', 'deformLimitExpansion', 'deformGroup', 'breakGroup', 'boundZone', 'pressurePSI', 'surface', 'volumeCoef',
];
let beamClipboard: Record<string, any> | null = null;

/** Copies the effective physical properties of a beam. */
export function copyBeamProps(beamIdx: number): void {
  const v = ws.vehicle;
  const b = v?.beams[beamIdx];
  if (!b) return;
  const out: Record<string, any> = {};
  for (const k of BEAM_PROPS) {
    const val = b.row.v[k];
    if (val !== undefined && val !== '') out[k] = val;
  }
  beamClipboard = out;
  toast('info', `Copied ${Object.keys(out).length} properties`);
}
export function beamClipboardSize(): number {
  return beamClipboard ? Object.keys(beamClipboard).length : 0;
}
/** Pastes copied beam properties onto beams (as inline options). */
export function pasteBeamProps(beamIdx: number[]): boolean {
  const v = ws.vehicle;
  if (!v || !beamClipboard) return false;
  return setRowValues(beamIdx.map((i) => v.beams[i].row), beamClipboard, `Paste properties on ${beamIdx.length} beam(s)`);
}

// ------------------------------------------------------------------------------------------
// extrude and bridge
// ------------------------------------------------------------------------------------------

/** Next free names from the quick-naming prefix with side suffixes (f12l, f12r, f13…). */
function namesFor(positions: Array<[number, number, number]>): string[] {
  const v = ws.vehicle!;
  const nm = useUi.getState().naming;
  const taken = new Set(v.nodeIndex.keys());
  let num = nm.next;
  return positions.map((p) => {
    let name = sidedName(nm.prefix, num, p[0]);
    while (taken.has(name)) name = sidedName(nm.prefix, ++num, p[0]);
    taken.add(name);
    return name;
  });
}

/**
 * Blender's extrude for a node cage: new nodes on top of the selected ones, beams between the
 * new nodes where the originals were connected, and a beam from each new node to its origin.
 * Returns the new names (the caller starts a move).
 */
export function extrudeNodes(indices: number[]): string[] {
  const v = ws.vehicle;
  if (!v || !indices.length) return [];
  const pos = indices.map((i) => [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z] as [number, number, number]);
  const names = namesFor(pos);
  const map = new Map(indices.map((i, k) => [i, names[k]]));
  return ws.group(`Extrude ${indices.length} node(s)`, () => {
    const made = addNodes(indices.map((i, k) => ({ name: names[k], x: pos[k][0], y: pos[k][1], z: pos[k][2], opts: nodeExtraOpts(v.nodes[i].row) })), 'Extrude');
    if (!made.length) return [];
    const set = new Set(indices);
    const pairs: Array<[string, string]> = indices.map((i) => [v.nodes[i].name, map.get(i)!] as [string, string]);
    for (const b of v.beams) if (set.has(b.a) && set.has(b.b)) pairs.push([map.get(b.a)!, map.get(b.b)!]);
    addBeams(pairs, undefined, 'Extrude beams');
    return made;
  });
}

/** Orders a set of nodes connected as a path (by existing beams); null when it is not a simple path. */
function asChain(v: Vehicle, nodes: number[]): number[] | null {
  const set = new Set(nodes);
  const adj = new Map<number, number[]>();
  for (const b of v.beams) {
    if (!set.has(b.a) || !set.has(b.b) || b.a === b.b) continue;
    (adj.get(b.a) ?? adj.set(b.a, []).get(b.a)!).push(b.b);
    (adj.get(b.b) ?? adj.set(b.b, []).get(b.b)!).push(b.a);
  }
  if (nodes.length === 1) return nodes;
  const ends = nodes.filter((i) => new Set(adj.get(i) ?? []).size === 1);
  const start = ends[0] ?? nodes[0];
  const out = [start];
  const seen = new Set(out);
  for (;;) {
    const cur = out[out.length - 1];
    const next = [...new Set(adj.get(cur) ?? [])].find((j) => !seen.has(j));
    if (next === undefined) break;
    out.push(next);
    seen.add(next);
  }
  return out.length === nodes.length ? out : null;
}

/** Splits nodes into groups connected by beams among themselves. */
function components(v: Vehicle, nodes: number[]): number[][] {
  const set = new Set(nodes);
  const adj = new Map<number, number[]>();
  for (const b of v.beams) {
    if (!set.has(b.a) || !set.has(b.b)) continue;
    (adj.get(b.a) ?? adj.set(b.a, []).get(b.a)!).push(b.b);
    (adj.get(b.b) ?? adj.set(b.b, []).get(b.b)!).push(b.a);
  }
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const comp: number[] = [];
    const q = [n];
    seen.add(n);
    while (q.length) {
      const i = q.pop()!;
      comp.push(i);
      for (const j of adj.get(i) ?? []) if (!seen.has(j)) {
        seen.add(j);
        q.push(j);
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Connects two node chains (each linked by beams) like a ladder: rungs between matching nodes,
 * cross bracing in every bay, and optionally two collision triangles per bay (normals outward).
 */
export function bridgeChains(nodes: number[], opts: { bracing: boolean; triangles: boolean }): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const comps = components(v, nodes);
  if (comps.length !== 2) {
    toast('info', `Select two chains of nodes, each connected by beams (found ${comps.length} group${comps.length === 1 ? '' : 's'})`);
    return false;
  }
  let a = asChain(v, comps[0]);
  let b = asChain(v, comps[1]);
  if (!a || !b) {
    toast('info', 'Each chain must be a simple line of beams (no branches)');
    return false;
  }
  const P = (i: number) => [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z];
  const dist = (i: number, j: number) => Math.hypot(P(i)[0] - P(j)[0], P(i)[1] - P(j)[1], P(i)[2] - P(j)[2]);
  // orient b like a
  if (dist(a[0], b[0]) + dist(a[a.length - 1], b[b.length - 1]) > dist(a[0], b[b.length - 1]) + dist(a[a.length - 1], b[0])) b = [...b].reverse();
  if (a.length < b.length) [a, b] = [b, a];
  // match each node of the longer chain to a node of the other by relative position along the chain
  const match = (k: number) => b![Math.round((k / Math.max(1, a!.length - 1)) * (b!.length - 1))];
  const N = (i: number) => v.nodes[i].name;
  const beams: Array<[string, string]> = [];
  const tris: Array<[string, string, string]> = [];
  for (let k = 0; k < a.length; k++) beams.push([N(a[k]), N(match(k))]);
  for (let k = 0; k + 1 < a.length; k++) {
    const a0 = a[k], a1 = a[k + 1], b0 = match(k), b1 = match(k + 1);
    if (opts.bracing) {
      if (b0 !== b1) beams.push([N(a0), N(b1)]);
      beams.push([N(a1), N(b0)]);
    }
    if (opts.triangles) {
      tris.push([N(a0), N(a1), N(b1)]);
      if (b0 !== b1) tris.push([N(a0), N(b1), N(b0)]);
    }
  }
  // collision triangles face outward: away from the vehicle centre
  if (tris.length) {
    let cx = 0, cy = 0, cz = 0;
    for (const n of v.nodes) {
      cx += n.x;
      cy += n.y;
      cz += n.z;
    }
    const c = [cx / v.nodes.length, cy / v.nodes.length, cz / v.nodes.length];
    const [p, q, r] = tris[0].map((n) => P(v.nodeIndex.get(n)!));
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const mid = [(p[0] + q[0] + r[0]) / 3 - c[0], (p[1] + q[1] + r[1]) / 3 - c[1], (p[2] + q[2] + r[2]) / 3 - c[2]];
    if (nrm[0] * mid[0] + nrm[1] * mid[1] + nrm[2] * mid[2] < 0) for (const t of tris) [t[1], t[2]] = [t[2], t[1]];
  }
  return ws.group('Bridge chains', () => {
    const nb = addBeams(beams, undefined, 'Bridge beams');
    const nt = tris.length ? addTris(tris, 'Bridge triangles') : 0;
    if (nb || nt) toast('info', `Bridge: ${nb} beams${nt ? `, ${nt} triangles (check their normals)` : ''}`);
    return nb > 0 || nt > 0;
  });
}

/** Turns box triggers to the nearest world-aligned orientation; their centre stays where it is. */
export function alignTriggersToWorld(indices: number[]): boolean {
  const v = ws.vehicle;
  if (!v) return false;
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  const placed = placeTriggers(v, pos);
  const vals = new Map<number, Record<string, any>>();
  let spheres = 0;
  for (const idx of indices) {
    const t = placed.find((x) => x.idx === idx);
    if (!t) continue;
    if (t.type === 'sphere') {
      spheres++;
      continue;
    }
    const axes = worldAlignedAxes(t.frame);
    const c = t.center;
    const origin: [number, number, number] = [0, 1, 2].map((k) => c[k] - axes.X[k] * t.size[0] / 2 - axes.Y[k] * t.size[1] / 2 - axes.Z[k] * t.size[2] / 2) as any;
    const toRaw = (q: [number, number, number]): [number, number, number] => {
      const r = invertNodeXform(getNodeXform(t.row.v), q[0], q[1], q[2]);
      return [r.x, r.y, r.z];
    };
    vals.set(idx, triggerValues(v, pos, t, { origin, axes }, toRaw));
  }
  if (!vals.size) {
    toast('info', spheres ? 'Sphere triggers have no orientation' : 'Select a box trigger');
    return false;
  }
  return setTriggerValues(vals, vals.size > 1 ? `Align ${vals.size} triggers to world` : 'Align trigger to world');
}
