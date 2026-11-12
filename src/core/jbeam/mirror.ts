/**
 * Mirrors a whole part to the other side of the vehicle (e.g. etkk_fender_R -> etkk_fender_L).
 * Works on the source text so formatting and comments carry over.
 */
import type { ANode, AObj, AArr, AStr } from '../sjson';
import { applyEdits, eolOf, indentAt, isLinkKey, lineEndOff, type TextEdit } from './edit';
import type { PartDef } from './types';

const SIDE_PAIRS: Array<[string, string]> = [
  ['FR', 'FL'], ['RR', 'RL'], ['R', 'L'], ['Right', 'Left'], ['right', 'left'], ['RH', 'LH'],
];

/** Swaps side tokens delimited by "_", "-", "." or string ends (e.g. door_FR -> door_FL, fender_R_a -> fender_L_a). */
export function swapSideTokens(s: string): string {
  return s
    .split(/([_\-.\s])/)
    .map((tok) => {
      for (const [a, b] of SIDE_PAIRS) {
        if (tok === a) return b;
        if (tok === b) return a;
      }
      return tok;
    })
    .join('');
}

export function hasSideToken(s: string): boolean {
  return swapSideTokens(s) !== s;
}

/** l <-> r node suffix swap (also ll <-> rr). */
export function mirrorNodeName(name: string, L = 'l', R = 'r'): string | null {
  const m = new RegExp(`^(.*?)(${L}+|${R}+)$`).exec(name);
  if (!m || !m[1]) return null;
  const suf = m[2];
  return m[1] + (suf.startsWith(L) ? R.repeat(suf.length / L.length) : L.repeat(suf.length / R.length));
}

export interface MirrorContext {
  /** node position lookup in the assembled vehicle (final coordinates) */
  nodeX(name: string): number | undefined;
  nodeExists(name: string): boolean;
  meshExists(name: string): boolean;
  partExists(name: string): boolean;
  suffixL: string;
  suffixR: string;
  centerTol: number;
}

export interface MirrorReport {
  newName: string;
  nodesRenamed: number;
  centerNodes: number;
  refsMirrored: number;
  refsKept: string[];
  trisFlipped: number;
  meshesSwapped: string[];
  meshesKept: string[];
  stringsSwapped: number;
  numbersMirrored: number;
  warnings: string[];
  conflicts: string[];
}

const GLOBAL_POS_KEYS = /^(pos|nodeMove\d*|baseTranslationGlobal|baseTranslationGlobalElastic|baseTranslationGlobalRigid|translationGlobal)$/;

function negText(t: string): string {
  const s = t.trim();
  if (/^-?0*\.?0*$/.test(s.replace(/^-/, ''))) return s.replace(/^-/, '');
  return s.startsWith('-') ? s.slice(1) : '-' + s;
}

function headerOf(arr: AArr): string[] {
  const h = arr.items[0];
  return h && h.k === 'arr' ? h.items.map((x) => (x.k === 'str' ? x.v : '')) : [];
}

/**
 * Builds the mirrored part text. Returns the text of the new `"name": {...}` entry and a report.
 */
export function mirrorPart(fileText: string, part: PartDef, ctx: MirrorContext): { text: string; report: MirrorReport } {
  const newName = swapSideTokens(part.name);
  const report: MirrorReport = {
    newName, nodesRenamed: 0, centerNodes: 0, refsMirrored: 0, refsKept: [], trisFlipped: 0, meshesSwapped: [], meshesKept: [],
    stringsSwapped: 0, numbersMirrored: 0, warnings: [], conflicts: [],
  };
  const base = part.key.s;
  const edits: TextEdit[] = [];
  const handled = new Set<ANode>();
  const set = (n: ANode, text: string) => {
    handled.add(n);
    edits.push({ s: n.s, e: n.e, text });
  };

  // 1) nodes defined by this part -> new names, X negated
  const nodeMap = new Map<string, string>();
  const nodesSec = part.sections.get('nodes');
  if (nodesSec && nodesSec.k === 'arr') {
    const h = headerOf(nodesSec);
    const ci = h.indexOf('id'), cx = h.indexOf('posX');
    for (let r = 1; r < nodesSec.items.length; r++) {
      const row = nodesSec.items[r];
      if (row.k !== 'arr') continue;
      const idc = row.items[ci], xc = row.items[cx];
      if (!idc || idc.k !== 'str') continue;
      const x = xc && xc.k === 'num' ? xc.v : ctx.nodeX(idc.v) ?? 0;
      let nn = idc.v;
      if (Math.abs(x) > ctx.centerTol) {
        nn = mirrorNodeName(idc.v, ctx.suffixL, ctx.suffixR) ?? swapSideTokens(idc.v);
        if (nn === idc.v) {
          nn = idc.v + '_m';
          report.warnings.push(`Node "${idc.v}" has no side suffix; named "${nn}"`);
        }
        report.nodesRenamed++;
        if (ctx.nodeExists(nn)) report.conflicts.push(nn);
      } else report.centerNodes++;
      nodeMap.set(idc.v, nn);
      if (xc && xc.k === 'num') {
        if (Math.abs(xc.v) > 0) {
          set(xc, negText(fileText.slice(xc.s, xc.e)));
          report.numbersMirrored++;
        }
      } else if (xc) report.warnings.push(`Node "${idc.v}": posX is an expression — check it`);
    }
  }

  const mapNode = (name: string): string => {
    const own = nodeMap.get(name);
    if (own !== undefined) return own;
    const x = ctx.nodeX(name);
    if (x !== undefined && Math.abs(x) <= ctx.centerTol) return name;
    const m = mirrorNodeName(name, ctx.suffixL, ctx.suffixR);
    if (m && ctx.nodeExists(m)) {
      report.refsMirrored++;
      return m;
    }
    if (!report.refsKept.includes(name)) report.refsKept.push(name);
    return name;
  };

  const strNode = (n: ANode) => {
    if (n.k === 'str') {
      const nn = mapNode(n.v);
      if (nn !== n.v) set(n, JSON.stringify(nn));
      else handled.add(n);
    } else if (n.k === 'arr') for (const it of n.items) strNode(it);
  };

  // generic string: swap side tokens (meshes only when the mirrored mesh exists)
  const genericStr = (n: AStr, key?: string) => {
    if (handled.has(n)) return;
    const v = n.v;
    if (!v || v.startsWith('$') || v.startsWith('|')) return;
    const sw = swapSideTokens(v);
    if (sw === v) return;
    if (key === 'mesh') {
      if (ctx.meshExists(sw)) {
        report.meshesSwapped.push(`${v} → ${sw}`);
      } else {
        if (!report.meshesKept.includes(v)) report.meshesKept.push(v);
        return;
      }
    }
    set(n, JSON.stringify(sw));
    report.stringsSwapped++;
  };

  const visitValue = (n: ANode, key?: string) => {
    if (handled.has(n)) return;
    if (n.k === 'str') genericStr(n, key);
    else if (n.k === 'arr') for (const it of n.items) visitValue(it, key);
    else if (n.k === 'obj') visitDict(n);
  };

  const visitDict = (o: AObj) => {
    for (let i = 0; i < o.keys.length; i++) {
      const k = o.keys[i].v;
      const v = o.vals[i];
      if (isLinkKey(k) || (k.startsWith('$') && /node/i.test(k))) {
        strNode(v);
        continue;
      }
      if (GLOBAL_POS_KEYS.test(k) && v.k === 'obj') {
        for (let j = 0; j < v.keys.length; j++) {
          if (v.keys[j].v === 'x' && v.vals[j].k === 'num' && (v.vals[j] as any).v !== 0) {
            set(v.vals[j], negText(fileText.slice(v.vals[j].s, v.vals[j].e)));
            report.numbersMirrored++;
          }
        }
        continue;
      }
      if (k === '$posX' && v.k === 'num') {
        if (v.v !== 0) {
          set(v, negText(fileText.slice(v.s, v.e)));
          report.numbersMirrored++;
        }
        continue;
      }
      if (k === '$rotZ' && v.k === 'num') {
        const z = ((-v.v % 360) + 360) % 360;
        if (z !== v.v) {
          set(v, String(+z.toFixed(4)));
          report.numbersMirrored++;
        }
        continue;
      }
      if (k === 'rot' && v.k === 'obj') report.warnings.push('A flexbody/prop keeps its "rot" — check rotations of reused symmetric meshes');
      visitValue(v, k);
    }
  };

  // 2) walk the sections
  for (const [section, node] of part.sections) {
    if (section === 'nodes' && node.k === 'arr') {
      const h = headerOf(node);
      const ci = h.indexOf('id');
      for (let r = 1; r < node.items.length; r++) {
        const row = node.items[r];
        if (row.k === 'arr') {
          const idc = row.items[ci];
          if (idc && idc.k === 'str') {
            const nn = nodeMap.get(idc.v);
            if (nn && nn !== idc.v) set(idc, JSON.stringify(nn));
            else handled.add(idc);
          }
          row.items.forEach((c, j) => j !== ci && h[j] !== 'posX' && visitValue(c, h[j]));
        } else visitValue(row);
      }
      continue;
    }
    if (node.k === 'arr' && node.items.length && node.items[0].k === 'arr') {
      const h = headerOf(node);
      const isTri = section === 'triangles';
      const isQuad = section === 'quads';
      for (let r = 1; r < node.items.length; r++) {
        const row = node.items[r];
        if (row.k !== 'arr') {
          visitValue(row);
          continue;
        }
        row.items.forEach((c, j) => {
          const col = h[j];
          if (col !== undefined && isLinkKey(col)) strNode(c);
          else visitValue(c, col);
        });
        if (isTri || isQuad) {
          // flip winding: swap id2 <-> id3 (triangles) or id2 <-> id4 (quads)
          const a = row.items[h.indexOf('id2:')];
          const b = row.items[h.indexOf(isTri ? 'id3:' : 'id4:')];
          if (a && b) {
            const ta = editedText(a), tb = editedText(b);
            setOverride(a, tb);
            setOverride(b, ta);
            report.trisFlipped++;
          }
        }
      }
      continue;
    }
    visitValue(node, section);
  }

  function editedText(n: ANode): string {
    for (let i = edits.length - 1; i >= 0; i--) if (edits[i].s === n.s && edits[i].e === n.e) return edits[i].text;
    return fileText.slice(n.s, n.e);
  }
  function setOverride(n: ANode, text: string) {
    for (let i = edits.length - 1; i >= 0; i--) if (edits[i].s === n.s && edits[i].e === n.e) edits.splice(i, 1);
    edits.push({ s: n.s, e: n.e, text });
    handled.add(n);
  }

  // part key
  edits.push({ s: part.key.s, e: part.key.e, text: JSON.stringify(newName) });
  // apply on the part slice
  const slice = fileText.slice(base, part.node.e);
  const local = edits.map((e) => ({ s: e.s - base, e: e.e - base, text: e.text }));
  const text = applyEdits(slice, local);
  if (ctx.partExists(newName)) report.conflicts.push(`part ${newName}`);
  if (part.sections.has('triggers2') || part.sections.has('triggers')) report.warnings.push('Box triggers: mirrored frames flip handedness — check box corners/rotations in game');
  if (part.sections.has('props')) report.warnings.push('Props: baseRotation / translation are kept — check them in game');
  report.warnings = [...new Set(report.warnings)];
  return { text, report };
}

/** Edit that inserts the new part right after the original one in the same file. */
export function insertPartAfter(fileText: string, part: PartDef, partText: string): TextEdit[] {
  const eol = eolOf(fileText);
  const ind = indentAt(fileText, part.key.s);
  const out: TextEdit[] = [];
  let at = part.node.e;
  let j = at;
  while (j < fileText.length && /[ \t]/.test(fileText[j])) j++;
  if (fileText[j] === ',') at = j + 1;
  else out.push({ s: part.node.e, e: part.node.e, text: ',' });
  // keep a trailing comment on the closing line attached to the original part
  const le = lineEndOff(fileText, at);
  if (/^\s*\/\//.test(fileText.slice(at, le))) at = le;
  out.push({ s: at, e: at, text: eol + ind + partText + ',' });
  return out;
}
