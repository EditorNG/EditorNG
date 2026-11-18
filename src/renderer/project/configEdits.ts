/**
 * Edits that concern configurations rather than one part: giving one configuration its own copy
 * of a part (so a change stays in that configuration), and the Power / Torque of info_*.json files.
 */
import { ws, useWs } from './workspace';
import { api } from '../lib/api';
import { parseSjson, objGet, type ANode, type AObj } from '@core/sjson';
import { copyPartBody, copyPartText, slug } from '@core/newmod';
import type { TextEdit } from '@core/jbeam/edit';
import { settings } from '../state/settings';
import { toast } from '../state/toast';

export const configName = (pcKey: string) => pcKey.split('/').pop()!.replace(/\.pc$/i, '');

/** vehicles/x/drift.pc -> vehicles/x/info_drift.json */
export const infoKeyOf = (pcKey: string) => pcKey.replace(/[^/]+\.pc$/i, (m) => 'info_' + m.replace(/\.pc$/i, '.json'));

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');

/** indentation of the first key of an object, or four spaces */
function indentIn(text: string, obj: AObj, fallback = '    '): string {
  const first = obj.keys[0];
  if (!first) return fallback;
  const ls = text.lastIndexOf('\n', first.s) + 1;
  const ind = text.slice(ls, first.s);
  return /^[ \t]*$/.test(ind) ? ind : fallback;
}

/** Text edits that make a .pc put `part` in `slot`; null when the file has no "parts" object. */
export function pcSlotEdits(text: string, slot: string, part: string): TextEdit[] | null {
  const root = parseSjson(text).root;
  if (!root || root.k !== 'obj') return null;
  const parts = objGet(root, 'parts');
  if (!parts || parts.k !== 'obj') return null;
  const cur = objGet(parts as AObj, slot);
  if (cur) return [{ s: cur.s, e: cur.e, text: JSON.stringify(part) }];
  return [{ s: parts.s + 1, e: parts.s + 1, text: `${eolOf(text)}${indentIn(text, parts as AObj)}${JSON.stringify(slot)}: ${JSON.stringify(part)},` }];
}

/** Why the active configuration can't get its own copy of a part, or null when it can. */
export function cannotCopyFor(partName: string): string | null {
  const v = ws.vehicle;
  const pc = ws.doc(useWs.getState().activeConfig);
  if (!v || !pc) return 'No configuration (.pc) is open';
  if (!pc.writable) return `${pc.name} is a game file: save the configuration into your mod first`;
  const ap = v.parts.find((p) => p.def.name === partName);
  if (!ap?.slot) return `${partName} is the vehicle's main part`;
  if (!pcSlotEdits(pc.text, ap.slot.id, partName)) return `${pc.name} has no "parts" list`;
  return null;
}

/**
 * Gives the active configuration its own copy of a part: the copy goes next to the original (or,
 * for a game part, into a new file next to the configuration), and the .pc's slot points to it.
 * Returns the copy's name.
 */
export async function copyPartForConfig(partName: string): Promise<string | null> {
  const why = cannotCopyFor(partName);
  if (why) {
    toast('warn', why);
    return null;
  }
  const v = ws.vehicle!;
  const pc = ws.doc(useWs.getState().activeConfig)!;
  const ap = v.parts.find((p) => p.def.name === partName)!;
  const slot = ap.slot!.id;
  const def = ap.def;
  const src = ws.doc(def.file);
  if (!src) {
    toast('warn', `${def.file} is not loaded`);
    return null;
  }
  const cfg = configName(pc.key);
  let name = `${partName}_${slug(cfg)}`;
  for (let k = 2; ws.lib?.get(name); k++) name = `${partName}_${slug(cfg)}_${k}`;
  const opt = { name, title: `${def.info.name ?? partName} (${cfg})`, author: def.info.authors ?? settings().authorName ?? '', slotType: def.slotTypes[0] ?? '' };
  const pcEdits = pcSlotEdits(pc.text, slot, name)!;
  // the session's slot choice would hide the .pc's
  delete ws.configOverride.parts[slot];
  if (src.writable) {
    const edits = new Map<string, TextEdit[]>([
      [src.key, [{ s: def.node.e, e: def.node.e, text: `,${eolOf(src.text)}${copyPartBody(src.text, def, opt)}` }]],
      [pc.key, pcEdits],
    ]);
    if (!ws.applyEdits(`Copy ${partName} for ${cfg}`, edits)) return null;
    toast('info', `${cfg} now uses ${name}`, undefined, 2500);
    return name;
  }
  // a game part: a new file next to the configuration
  if (useWs.getState().dirtyCount) {
    toast('warn', 'Save your changes first: the copy of a game part goes into a new file');
    return null;
  }
  const real = pc.ref.real;
  if (!real) return null;
  const file = real.replace(/[^\\/]+$/, `${name}.jbeam`);
  await api.writeTextFile(file, copyPartText(src.text, def, opt));
  if (!ws.applyEdits(`Use ${name} in ${cfg}`, new Map([[pc.key, pcEdits]]))) return null;
  await ws.save(pc.key);
  await api.vfsRescan();
  await ws.reloadFromDisk();
  toast('info', `${cfg} now uses ${name} (${file.split(/[\\/]/).pop()})`, undefined, 3000);
  return name;
}

export interface InfoValues {
  key: string;
  writable: boolean;
  power?: ANode;
  torque?: ANode;
}

/** The Power / Torque of a configuration's info file (the vehicle selector's numbers). */
export function readInfo(pcKey: string): InfoValues | null {
  const d = ws.doc(infoKeyOf(pcKey));
  if (!d) return null;
  const root = parseSjson(d.text).root;
  if (!root || root.k !== 'obj') return { key: d.key, writable: d.writable };
  const num = (k: string) => {
    const n = objGet(root as AObj, k);
    return n && n.k === 'num' ? n : undefined;
  };
  return { key: d.key, writable: d.writable, power: num('Power'), torque: num('Torque') };
}

/** Writes Power (hp) and Torque (Nm) into info files, one undo step. */
export function writeInfo(rows: Array<{ pcKey: string; hp: number; nm: number }>): boolean {
  const map = new Map<string, TextEdit[]>();
  for (const r of rows) {
    const info = readInfo(r.pcKey);
    const d = info && ws.doc(info.key);
    if (!info || !d?.writable) continue;
    const hp = String(Math.round(r.hp)), nm = String(Math.round(r.nm));
    const edits: TextEdit[] = [];
    const missing: string[] = [];
    if (info.power) edits.push({ s: info.power.s, e: info.power.e, text: hp });
    else missing.push(`"Power":${hp},`);
    if (info.torque) edits.push({ s: info.torque.s, e: info.torque.e, text: nm });
    else missing.push(`"Torque":${nm},`);
    if (missing.length) {
      const root = parseSjson(d.text).root;
      if (!root || root.k !== 'obj') continue;
      const ind = indentIn(d.text, root as AObj, '  ');
      edits.push({ s: root.s + 1, e: root.s + 1, text: missing.map((m) => `${eolOf(d.text)}${ind}${m}`).join('') });
    }
    map.set(d.key, edits);
  }
  if (!map.size) return false;
  return ws.applyEdits('Update Power / Torque in info files', map);
}
