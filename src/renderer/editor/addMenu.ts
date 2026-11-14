/**
 * The code editor's Add menu (right-click → Add…, or Alt+Insert): blank sections for the part under
 * the cursor, a new part in this file, a flexbody. Sections go before the section the cursor is in,
 * or at the end of the part; the editor then centres on the new section with the caret inside it.
 */
import { monaco } from '../lib/monaco';
import { ws, type Doc } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { toast } from '../state/toast';
import { openMenu, type MenuEntry } from '../ui/Menu';
import { pathAt, type AObj } from '@core/sjson';
import type { PartDef } from '@core/jbeam/types';
import { SECTION_DEFS, insertKeyAt, sectionValue } from '@core/jbeam/sections';
import { getEditor, revealRange } from './CodeEditor';

/** The part at an offset of a jbeam document, and the index of the part key the cursor is in. */
export function partAt(d: Doc, offset: number): { part: PartDef; keyIndex: number | null } | null {
  const parts = d.jfile?.parts ?? [];
  if (!parts.length) return null;
  const path = d.jfile?.root ? pathAt(d.jfile.root, offset) : [];
  const name = path[1]?.key;
  const part = parts.find((p) => p.name === name);
  if (part) {
    // path[2]: the key of the part object the cursor is in (a section, information…)
    const keyIndex = path[2]?.index ?? null;
    return { part, keyIndex };
  }
  // between parts: the last part that starts before the cursor (or the first one)
  const before = [...parts].reverse().find((p) => p.key.s <= offset);
  return { part: before ?? parts[0], keyIndex: null };
}

/** Moves the caret to an offset of the open document and centres it. */
function caretTo(d: Doc, offset: number) {
  const ed = getEditor();
  const m = d.model;
  if (!ed || !m || ed.getModel() !== m) return;
  const p = m.getPositionAt(offset);
  ed.setPosition(p);
  ed.revealPositionInCenter(p, monaco.editor.ScrollType.Smooth);
  ed.focus();
}

export function addSection(docKey: string, offset: number, key: string): boolean {
  const d = ws.doc(docKey);
  const def = SECTION_DEFS.find((s) => s.key === key);
  if (!d || !def) return false;
  if (!d.writable) {
    toast('warn', `${d.name} is read-only. Right-click it in the explorer → "Make editable copy".`);
    return false;
  }
  const at = partAt(d, offset);
  if (!at) {
    toast('info', 'This file has no part yet: add a new part first');
    return false;
  }
  const { part, keyIndex } = at;
  if (part.node.keys.some((k) => k.v === key)) {
    const k = part.sectionKeys.get(key) ?? part.node.keys.find((x) => x.v === key);
    if (k) revealRange(d.key, k.s, k.e, true);
    return false;
  }
  // before the section the cursor is in; elsewhere at the end of the part
  const r = insertKeyAt(d.text, part.node as AObj, keyIndex, key, (ind, unit, eol) => sectionValue(def, ind, unit, eol));
  if (!ws.applyEdits(`Add ${key} to ${part.name}`, new Map([[d.key, r.edits]]))) return false;
  if (r.cursor !== null) caretTo(d, r.cursor);
  return true;
}

/** Add menu entries for a document position (also used by the editor's context menu). */
export function addMenuItems(docKey: string, offset: number): MenuEntry[] {
  const d = ws.doc(docKey);
  if (!d || d.lang !== 'jbeam') return [{ label: 'Add', disabled: 'Only in .jbeam files' }];
  const at = partAt(d, offset);
  const ro = d.writable ? false : 'Read-only file: make an editable copy first';
  const groups = [...new Set(SECTION_DEFS.map((s) => s.group))];
  const sections: MenuEntry[] = at
    ? groups.map((g) => ({
        label: g,
        disabled: ro,
        submenu: SECTION_DEFS.filter((s) => s.group === g).map((s) => {
          const has = at.part.node.keys.some((k) => k.v === s.key);
          return { label: s.label, hint: has ? 'go to' : undefined, run: () => addSection(docKey, offset, s.key) };
        }),
      }))
    : [{ label: 'Sections', disabled: 'Add a part to this file first' }];
  return [
    { title: at ? `Add to ${at.part.name}` : `Add to ${d.name}` },
    ...sections,
    'sep',
    { label: 'New part in this file…', disabled: ro, run: () => useUi.setState({ dialog: { kind: 'newPart', data: { doc: d.key, offset } } }) },
    { label: 'Flexbody…', disabled: at ? ro : 'Add a part to this file first', run: () => useUi.setState({ dialog: { kind: 'flexbody', data: { doc: d.key, part: at?.part.name } } }) },
  ];
}

export function openAddMenu(x: number, y: number, docKey: string, offset: number) {
  openTab(docKey);
  openMenu(x, y, addMenuItems(docKey, offset));
}
