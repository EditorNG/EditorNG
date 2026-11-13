/**
 * Known modifier / option names per section, read from the game's own spellchecker
 * (lua/ge/extensions/editor/vehicleEditor/staticEditor/veJBeamSpellchecker.lua, table allSections).
 * Only sections with a non-empty list are checked.
 */

/** Parses the allSections table of the game's spellchecker Lua file. */
export function parseSpellcheckerLua(text: string): Record<string, string[]> | null {
  const start = text.indexOf('local allSections = {');
  if (start < 0) return null;
  // the table ends at the first line that is exactly "}"
  const end = text.indexOf('\n}', start);
  const body = text.slice(start, end < 0 ? undefined : end);
  const out: Record<string, string[]> = {};
  const secRe = /^ {2}(\w+) = \{([\s\S]*?)^ {2}\},?/gm;
  let m: RegExpExecArray | null;
  while ((m = secRe.exec(body))) {
    const keys: string[] = [];
    const keyRe = /^\s*(?:\["([^"]+)"\]|([A-Za-z_]\w*))\s*=\s*true/gm;
    let k: RegExpExecArray | null;
    while ((k = keyRe.exec(m[2]))) keys.push(k[1] ?? k[2]);
    if (keys.length) out[m[1]] = keys;
  }
  return Object.keys(out).length ? out : null;
}

let known: Record<string, Set<string>> = {};

export function setKnownProps(lists: Record<string, string[]>) {
  known = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, new Set(v)]));
}

/** null when the section is not checked */
export function knownPropsOf(section: string): Set<string> | null {
  return known[section] ?? null;
}

/** Closest known name (Damerau-free Levenshtein), when close enough to be a likely typo. */
export function suggestProp(section: string, name: string): string | null {
  const set = known[section];
  if (!set) return null;
  let best: string | null = null;
  let bd = Infinity;
  const lc = name.toLowerCase();
  for (const k of set) {
    if (k.toLowerCase() === lc) return k;
    const d = lev(lc, k.toLowerCase());
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return bd <= Math.max(2, Math.floor(name.length / 4)) ? best : null;
}

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 4) return 99;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

import type { AArr, AObj } from '../sjson';
import type { JFile, PartDef } from './types';

/** valid names the game's spellchecker list lacks (seen in vanilla vehicles) */
const EXTRA = new Set(['vkTag', 'disable', 'materialOverride', 'beamPrecompressionRange', 'pressureLimitPSI', 'hideInUI', 'breakGroup', 'deformGroup', 'optional', 'name', 'tag', 'pairedNode']);

export interface UnknownProp {
  section: string;
  part: string;
  key: string;
  s: number;
  e: number;
  suggestion: string | null;
}

/** Modifier rows and inline options using names the game does not know (likely typos). */
export function unknownProps(f: JFile): UnknownProp[] {
  return unknownPropsOfParts(f.parts);
}

export function unknownPropsOfParts(parts: PartDef[]): UnknownProp[] {
  const out: UnknownProp[] = [];
  for (const p of parts) {
    for (const [section, node] of p.sections) {
      const set = knownPropsOf(section);
      if (!set || node.k !== 'arr' || !node.items.length) continue;
      const h = node.items[0];
      const hlen = h.k === 'arr' ? h.items.length : 0;
      const check = (o: AObj) => {
        o.keys.forEach((k) => {
          if (set.has(k.v) || EXTRA.has(k.v) || /^node(Move|Offset|Rotate)\d*$/.test(k.v) || k.v.startsWith('$')) return;
          // the game's list is not complete: only names close to a known one are reported (likely typos)
          const suggestion = suggestProp(section, k.v);
          if (!suggestion || suggestion === k.v) return;
          out.push({ section, part: p.name, key: k.v, s: k.s, e: k.e, suggestion });
        });
      };
      for (let i = 1; i < node.items.length; i++) {
        const row = node.items[i];
        if (row.k === 'obj') check(row);
        else if (row.k === 'arr' && row.items.length > hlen) {
          const last = (row as AArr).items[row.items.length - 1];
          if (last.k === 'obj') check(last);
        }
      }
    }
  }
  return out;
}
