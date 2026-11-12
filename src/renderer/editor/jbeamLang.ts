/**
 * JBeam language support for Monaco: tokens, hovers, completion, go-to-definition, references,
 * rename, outline, folding, inlay hints (beam lengths), diagnostics, quick fixes and table alignment.
 */
import { monaco } from '../lib/monaco';
import { ws, type Doc } from '../project/workspace';
import { pathAt, LineIndex, type ANode, type AObj, type AArr, type AStr } from '@core/sjson';
import { SECTIONS, KEYS, BEAM_TYPES, NODE_MATERIALS, COMMON_ACTIONS, GENERIC_ACTIONS } from '@core/jbeam/docs';
import { findNodeTokens, isLinkKey } from '@core/jbeam/edit';
import type { PartDef, Vehicle } from '@core/jbeam/types';
import { settings } from '../state/settings';
import { meshes } from '../scene/meshes';
import { renameNode } from '../project/ops';

export const LANG = 'jbeam';

export function docOfModel(model: monaco.editor.ITextModel): Doc | undefined {
  for (const d of ws.docs.values()) if (d.model === model) return d;
  return undefined;
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : String(n);
}

/** Context of an offset inside a jbeam document. */
export interface Ctx {
  doc: Doc;
  part?: PartDef;
  section?: string;
  sectionNode?: ANode;
  row?: AArr;
  rowIndex?: number;
  header?: string[];
  col?: number;
  colName?: string;
  /** deepest node */
  leaf?: ANode;
  /** key of the dict entry containing the offset, if any */
  dictKey?: string;
  onKey?: boolean;
  path: ReturnType<typeof pathAt>;
}

export function contextAt(doc: Doc, offset: number): Ctx {
  const root = doc.jfile?.root ?? null;
  const path = pathAt(root, offset);
  const ctx: Ctx = { doc, path };
  if (path.length >= 2 && path[1].key && doc.jfile) {
    ctx.part = doc.jfile.parts.find((p) => p.name === path[1].key);
  }
  if (path.length >= 3) {
    ctx.section = path[2].key;
    ctx.sectionNode = path[2].node;
  }
  const sec = ctx.sectionNode;
  if (sec && sec.k === 'arr' && path.length >= 4) {
    const h = sec.items[0];
    ctx.header = h && h.k === 'arr' ? h.items.map((x) => (x.k === 'str' ? x.v : '')) : undefined;
    const rowNode = path[3].node;
    if (rowNode.k === 'arr') {
      ctx.row = rowNode;
      ctx.rowIndex = path[3].index;
      if (path.length >= 5) {
        ctx.col = path[4].index;
        if (ctx.header && ctx.col !== undefined && ctx.rowIndex !== 0) ctx.colName = ctx.header[ctx.col];
      }
    }
  }
  const last = path[path.length - 1];
  ctx.leaf = last?.node;
  // nearest dict key on the path
  for (let i = path.length - 1; i >= 1; i--) {
    const parent = path[i - 1].node;
    if (parent.k === 'obj' && path[i].key !== undefined) {
      ctx.dictKey = path[i].key;
      ctx.onKey = last.node.k === 'str' && (parent as AObj).keys.includes(last.node as AStr);
      break;
    }
  }
  return ctx;
}

function isNodeRefCtx(ctx: Ctx): boolean {
  if (ctx.onKey) return false;
  if (ctx.colName && isLinkKey(ctx.colName)) return true;
  if (ctx.section === 'nodes' && ctx.colName === 'id') return true;
  if (ctx.dictKey && (isLinkKey(ctx.dictKey) || (ctx.dictKey.startsWith('$') && /node/i.test(ctx.dictKey)))) return true;
  return false;
}

function nodeHover(v: Vehicle, name: string): string | null {
  const i = v.nodeIndex.get(name);
  if (i === undefined) return null;
  const n = v.nodes[i];
  let beams = 0;
  for (const b of v.beams) if (b.a === i || b.b === i) beams++;
  const w = n.row.v.nodeWeight ?? v.options.nodeWeight ?? 25;
  const raw = n.raw && (n.raw[0] !== n.x || n.raw[1] !== n.y || n.raw[2] !== n.z) ? `\n\nraw (before nodeOffset/Move/Rotate): \`${n.raw.map((x) => fmt(x)).join(', ')}\`` : '';
  return `**node \`${name}\`** — part \`${n.row.part.def.name}\`\n\n\`x ${fmt(n.x)}  y ${fmt(n.y)}  z ${fmt(n.z)}\`${raw}\n\nweight ${fmt(Number(w), 2)} kg · ${beams} beams${n.groups.length ? ` · groups: ${n.groups.join(', ')}` : ''}`;
}

const GOOD_TYPES = new Set(['beams', 'hydros']);

export function registerJbeam(): void {
  monaco.languages.register({ id: LANG, extensions: ['.jbeam', '.pc'], aliases: ['JBeam'] });
  monaco.languages.register({ id: 'lua', extensions: ['.lua'], aliases: ['Lua'] });
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    wordPattern: /(-?\d*\.\d\w*)|([^\s\[\]{}",:]+)/g,
  });
  monaco.languages.setMonarchTokensProvider(LANG, {
    defaultToken: '',
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"(\$=)([^"]*)"/, ['string.expr', 'string.expr']],
        [/"\$[^"]*"/, 'variable'],
        [/"\|[^"]*"/, 'type.flag'],
        [/"(nodes|beams|triangles|quads|hydros|torsionbars|flexbodies|props|slots2?|information|slotType|variables|refNodes|pressureWheels|hubWheels|wheels|rotators|triggers2?|triggerEventLinks2?|actionsEnabled|controller|powertrain|rails|slidenodes|glowMap|sounds|components|cameraExternal|camerasInternal|occupantSystem|thrusters|ropes|soundscape)"(?=\s*:)/, 'keyword.section'],
        [/"[^"]*"(?=\s*:)/, 'key'],
        [/"[^"\n]*"?/, 'string'],
        [/-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/, 'number'],
        [/\b(true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[,:]/, 'delimiter'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  } as any);
  monaco.languages.setMonarchTokensProvider('lua', {
    keywords: ['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while'],
    tokenizer: {
      root: [
        [/--\[\[/, 'comment', '@longcomment'],
        [/--.*$/, 'comment'],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\[\[/, 'string', '@longstring'],
        [/\d+\.?\d*([eE][+-]?\d+)?/, 'number'],
      ],
      longcomment: [
        [/\]\]/, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      longstring: [
        [/\]\]/, 'string', '@pop'],
        [/./, 'string'],
      ],
    },
  } as any);

  // ---------------------------------------------------------------- hover
  monaco.languages.registerHoverProvider(LANG, {
    provideHover(model, position) {
      const doc = docOfModel(model);
      const v = ws.vehicle;
      if (!doc || !doc.jfile) return null;
      const off = model.getOffsetAt(position);
      const ctx = contextAt(doc, off);
      const leaf = ctx.leaf;
      if (!leaf) return null;
      const range = (n: ANode) => {
        const a = model.getPositionAt(n.s), b = model.getPositionAt(n.e);
        return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      };
      const md: string[] = [];
      if (leaf.k === 'str' && ctx.onKey) {
        const key = leaf.v;
        if (ctx.path.length === 3 && SECTIONS[key]) {
          const sd = SECTIONS[key];
          md.push(`**${key}** — ${sd.doc}`);
          if (sd.header) md.push('`' + JSON.stringify(sd.header) + '`');
        } else if (ctx.path.length === 2) {
          const p = ws.vehicle?.partsByName.get(key);
          md.push(`**part \`${key}\`**` + (ctx.part?.info.name ? ` — ${ctx.part.info.name}` : ''));
          if (ctx.part) md.push(`slotType: \`${ctx.part.slotTypes.join(', ')}\``);
          md.push(p ? `active at \`${p.path}\`` : '_not active in the current configuration_');
        } else {
          const base = key.replace(/^\$[+*<>]?/, '');
          if (KEYS[base]) md.push(`**${key}** — ${KEYS[base]}`);
        }
        return md.length ? { range: range(leaf), contents: md.map((value) => ({ value })) } : null;
      }
      if (v && leaf.k === 'str' && isNodeRefCtx(ctx)) {
        const h = nodeHover(v, leaf.v);
        if (h) md.push(h);
        else md.push(`node \`${leaf.v}\` **not found** in the assembled vehicle`);
      } else if (leaf.k === 'str' && leaf.v.startsWith('$') && v) {
        const name = leaf.v.startsWith('$=') ? null : leaf.v;
        if (name) {
          const vd = v.variables.find((x) => x.name === name);
          if (vd) md.push(`**${name}** = \`${vd.val}\`${vd.unit ? ' ' + vd.unit : ''} (default ${vd.default}, range ${vd.min}…${vd.max})${vd.title ? `\n\n${vd.title}` : ''}\n\ndefined in \`${vd.part}\``);
          else if (name in v.vars) md.push(`**${name}** = \`${JSON.stringify(v.vars[name])}\``);
        } else {
          md.push('Expression (evaluated like Lua in the game).');
        }
      }
      // row summary
      if (v && ctx.row && ctx.rowIndex) {
        const refs = ws.rowIndex.get(ctx.row);
        if (refs?.length) {
          const r = refs[0];
          if (r.kind === 'beam') {
            const b = v.beams[r.idx];
            const A = v.nodes[b.a], B = v.nodes[b.b];
            const len = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
            const o = b.row.v;
            md.push(
              `**${b.type.toLowerCase()} beam** \`${A.name}\` → \`${B.name}\` · length **${fmt(len)} m**\n\n` +
                ['beamSpring', 'beamDamp', 'beamDeform', 'beamStrength', 'deformGroup', 'breakGroup', 'beamPrecompression', 'beamLongBound', 'beamShortBound']
                  .filter((k) => o[k] !== undefined && o[k] !== '')
                  .map((k) => `${k}: \`${typeof o[k] === 'number' ? (Number.isFinite(o[k]) ? o[k] : 'FLT_MAX') : JSON.stringify(o[k])}\``)
                  .join(' · '),
            );
          } else if (r.kind === 'tri') {
            const t = v.tris[r.idx];
            const A = v.nodes[t.a], B = v.nodes[t.b], C = v.nodes[t.c];
            const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z, wx = C.x - A.x, wy = C.y - A.y, wz = C.z - A.z;
            const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
            const area = Math.hypot(nx, ny, nz) / 2;
            md.push(`**triangle** area ${fmt(area * 1e4, 1)} cm² · normal \`${fmt(nx / (2 * area || 1), 2)}, ${fmt(ny / (2 * area || 1), 2)}, ${fmt(nz / (2 * area || 1), 2)}\``);
          } else if (r.kind === 'node' && !md.length) {
            const h = nodeHover(v, v.nodes[r.idx].name);
            if (h) md.push(h);
          } else if (r.kind === 'flex') {
            const f = v.flexbodies[r.idx];
            const file = meshes.fileOf(f.mesh);
            const g = meshes.get(f.mesh);
            md.push(`**flexbody \`${f.mesh}\`** ${g ? '' : g === null ? '— _mesh not found_' : '— _not loaded_'}${file ? `\n\nfrom \`${file.vpath}\` (${file.source})` : ''}\n\ngroups: ${f.groups.map((x) => '`' + x + '`').join(', ') || '_none_'}`);
          }
        }
      }
      if (!md.length && leaf.k === 'num' && ctx.colName) md.push(`\`${ctx.colName}\``);
      if (!md.length) return null;
      return { range: range(leaf), contents: md.map((value) => ({ value })) };
    },
  });

  // ---------------------------------------------------------------- completion
  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: ['"', '$', '|'],
    provideCompletionItems(model, position) {
      const doc = docOfModel(model);
      if (!doc) return { suggestions: [] };
      const v = ws.vehicle;
      const off = model.getOffsetAt(position);
      const text = model.getValue();
      // word under cursor (inside quotes)
      let ws0 = off;
      while (ws0 > 0 && !/["\s,[\]{}:]/.test(text[ws0 - 1])) ws0--;
      let we = off;
      while (we < text.length && !/["\s,[\]{}:]/.test(text[we])) we++;
      const inQuote = text[ws0 - 1] === '"';
      const a = model.getPositionAt(ws0), b = model.getPositionAt(we);
      const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      const word = text.slice(ws0, off);
      const q = (s: string) => (inQuote ? s : JSON.stringify(s));
      const ctx = doc.jfile ? contextAt(doc, Math.max(0, off - 1)) : null;
      const K = monaco.languages.CompletionItemKind;
      const out: monaco.languages.CompletionItem[] = [];

      if (word.startsWith('$') && v) {
        for (const vd of v.variables) out.push({ label: vd.name, kind: K.Variable, insertText: vd.name, range, detail: `${vd.val}${vd.unit ? ' ' + vd.unit : ''} — ${vd.part}`, documentation: vd.title });
        return { suggestions: out };
      }
      if (word.startsWith('|')) {
        for (const t of [...BEAM_TYPES, ...NODE_MATERIALS]) out.push({ label: t, kind: K.EnumMember, insertText: t, range });
        return { suggestions: out };
      }
      // decide key vs value position by scanning back from the token start
      let j = (inQuote ? ws0 - 1 : ws0) - 1;
      while (j >= 0 && /\s/.test(text[j])) j--;
      const prev = text[j];
      // container
      let container: ANode | undefined;
      if (ctx) for (let i = ctx.path.length - 1; i >= 0; i--) {
        const n = ctx.path[i].node;
        if ((n.k === 'obj' || n.k === 'arr') && n.s < off && off < n.e) {
          container = n;
          break;
        }
      }
      const depthOf = (n: ANode | undefined) => (ctx && n ? ctx.path.findIndex((p) => p.node === n) : -1);
      const cDepth = depthOf(container);

      if (container?.k === 'obj' && prev !== ':') {
        // key position
        if (cDepth === 1) {
          for (const [name, sd] of Object.entries(SECTIONS)) {
            const body = sd.kind === 'table' ? `[\n\t${JSON.stringify(sd.header ?? [])},\n\t$0\n],` : sd.kind === 'dict' ? '{\n\t$0\n},' : '$0,';
            out.push({
              label: name,
              kind: K.Module,
              insertText: (inQuote ? name + '": ' : JSON.stringify(name) + ': ') + body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range: inQuote ? new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column + (text[we] === '"' ? 1 : 0)) : range,
              documentation: { value: sd.doc },
            });
          }
        } else if (cDepth === 0) {
          out.push({
            label: 'new part',
            kind: K.Snippet,
            insertText: (inQuote ? '' : '"') + '${1:part_name}": {\n\t"information": {"authors": "${2:me}", "name": "${3:New Part}", "value": 0},\n\t"slotType": "${4:slot_type}",\n\t$0\n},',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          });
        } else {
          for (const [k, d] of Object.entries(KEYS)) out.push({ label: k, kind: K.Property, insertText: q(k), range, documentation: d });
        }
        return { suggestions: out };
      }
      // value positions
      const colName = ctx?.colName;
      const dictKey = ctx?.dictKey;
      const wantsNode = ctx && (isNodeRefCtx(ctx) || (colName && isLinkKey(colName)));
      if (wantsNode && v && !(ctx!.section === 'nodes' && colName === 'id')) {
        const partName = ctx!.part?.name;
        v.nodes.forEach((n) => {
          out.push({
            label: n.name,
            kind: K.Reference,
            insertText: q(n.name),
            range,
            detail: `${fmt(n.x, 2)}, ${fmt(n.y, 2)}, ${fmt(n.z, 2)} — ${n.row.part.def.name}`,
            sortText: (n.row.part.def.name === partName ? '0' : '1') + n.name,
          });
        });
        return { suggestions: out };
      }
      if (colName === 'mesh' || dictKey === 'mesh') {
        for (const n of meshes.knownNames()) out.push({ label: n, kind: K.File, insertText: q(n), range });
        return { suggestions: out };
      }
      if (colName === '[group]:' || dictKey === 'group' || colName === 'group' || colName === 'hubGroup') {
        const groups = new Set<string>();
        v?.nodes.forEach((n) => n.groups.forEach((g) => groups.add(g)));
        for (const g of groups) out.push({ label: g, kind: K.Folder, insertText: q(g), range });
        return { suggestions: out };
      }
      if ((colName === 'default' && (ctx?.section === 'slots2' || ctx?.section === 'slots')) || /\.pc$/i.test(doc.vpath)) {
        for (const p of ws.lib?.all() ?? []) out.push({ label: p.name, kind: K.Class, insertText: q(p.name), range, detail: p.info.name ?? '', documentation: p.slotTypes.join(', ') });
        return { suggestions: out };
      }
      if (colName === 'inputAction') {
        for (const x of [...COMMON_ACTIONS, ...GENERIC_ACTIONS]) out.push({ label: x, kind: K.Event, insertText: q(x), range });
        return { suggestions: out };
      }
      if (colName === 'triggerId:triggers2' && v) {
        for (const r of v.triggers) if (typeof r.v.id === 'string') out.push({ label: r.v.id, kind: K.Event, insertText: q(r.v.id), range });
        return { suggestions: out };
      }
      if (ctx?.section === 'nodes' && colName === 'id' && v) {
        out.push({ label: suggestName(v, word), kind: K.Value, insertText: q(suggestName(v, word)), range, detail: 'next free name' });
        return { suggestions: out };
      }
      if (dictKey === 'beamType') for (const t of BEAM_TYPES) out.push({ label: t, kind: K.EnumMember, insertText: q(t), range });
      if (dictKey === 'nodeMaterial') for (const t of NODE_MATERIALS) out.push({ label: t, kind: K.EnumMember, insertText: q(t), range });
      // row snippet at table level
      if (container?.k === 'arr' && cDepth === 2 && ctx?.header && !inQuote) {
        const h = ctx.header;
        out.push({
          label: 'row: ' + JSON.stringify(h),
          kind: K.Snippet,
          insertText: '[' + h.map((c, i) => (c.startsWith('pos') ? `\${${i + 1}:0}` : `"\${${i + 1}}"`)).join(', ') + '],',
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        });
        out.push({ label: 'modifier row {…}', kind: K.Snippet, insertText: '{"${1:beamSpring}":${2:0}},', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range });
      }
      return { suggestions: out };
    },
  });

  // ---------------------------------------------------------------- definition / references
  const nodeAt = (model: monaco.editor.ITextModel, position: monaco.Position): { name: string; leaf: ANode; doc: Doc } | null => {
    const doc = docOfModel(model);
    if (!doc?.jfile) return null;
    const ctx = contextAt(doc, model.getOffsetAt(position));
    if (ctx.leaf?.k === 'str' && isNodeRefCtx(ctx)) return { name: ctx.leaf.v, leaf: ctx.leaf, doc };
    return null;
  };
  const locOf = (file: string, s: number, e: number): monaco.languages.Location | null => {
    const d = ws.doc(file);
    if (!d) return null;
    const m = ws.ensureModel(d);
    const a = m.getPositionAt(s), b = m.getPositionAt(e);
    return { uri: m.uri, range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column) };
  };
  monaco.languages.registerDefinitionProvider(LANG, {
    provideDefinition(model, position) {
      const v = ws.vehicle;
      const doc = docOfModel(model);
      if (!doc?.jfile) return null;
      const n = nodeAt(model, position);
      if (n && v) {
        const i = v.nodeIndex.get(n.name);
        if (i === undefined) return null;
        const src = v.nodes[i].row.src;
        return locOf(src.file, src.node.s, src.node.e);
      }
      const ctx = contextAt(doc, model.getOffsetAt(position));
      const leaf = ctx.leaf;
      if (leaf?.k === 'str') {
        if (leaf.v.startsWith('$') && v) {
          const vd = v.variables.find((x) => x.name === leaf.v);
          if (vd?.row) return locOf(vd.file, vd.row.s, vd.row.e);
        }
        const p = ws.lib?.get(leaf.v);
        if (p) return locOf(p.file, p.key.s, p.key.e);
      }
      return null;
    },
  });
  monaco.languages.registerReferenceProvider(LANG, {
    provideReferences(model, position) {
      const n = nodeAt(model, position);
      if (!n) return [];
      const out: monaco.languages.Location[] = [];
      for (const d of ws.docs.values()) {
        if (!d.jfile || (d.isCommon && !d.model)) continue;
        for (const p of d.jfile.parts) for (const t of findNodeTokens(p, n.name)) {
          const l = locOf(d.key, t.s, t.e);
          if (l) out.push(l);
        }
      }
      return out;
    },
  });
  monaco.languages.registerRenameProvider(LANG, {
    resolveRenameLocation(model, position) {
      const n = nodeAt(model, position);
      if (!n) return { range: new monaco.Range(1, 1, 1, 1), text: '', rejectReason: 'Rename works on node names' };
      const a = model.getPositionAt(n.leaf.s + 1), b = model.getPositionAt(n.leaf.e - 1);
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: n.name };
    },
    provideRenameEdits(model, position, newName) {
      const n = nodeAt(model, position);
      if (n) renameNode(n.name, newName);
      return { edits: [] };
    },
  });

  // ---------------------------------------------------------------- outline
  monaco.languages.registerDocumentSymbolProvider(LANG, {
    provideDocumentSymbols(model) {
      const doc = docOfModel(model);
      if (!doc?.jfile?.root || doc.jfile.root.k !== 'obj') return [];
      const rng = (n: ANode) => {
        const a = model.getPositionAt(n.s), b = model.getPositionAt(n.e);
        return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      };
      const root = doc.jfile.root;
      const K = monaco.languages.SymbolKind;
      return root.keys.map((k, i) => {
        const val = root.vals[i];
        const children = val.k === 'obj' ? val.keys.map((sk, j) => {
          const sv = val.vals[j];
          const count = sv.k === 'arr' ? Math.max(0, sv.items.filter((x) => x.k === 'arr').length - 1) : 0;
          return { name: sk.v, detail: count ? `${count} rows` : '', kind: sv.k === 'arr' ? K.Array : sv.k === 'obj' ? K.Object : K.Field, range: rng({ ...sv, s: sk.s } as ANode), selectionRange: rng(sk), tags: [], children: [] };
        }) : [];
        return { name: k.v, detail: doc.jfile!.parts.find((p) => p.name === k.v)?.info.name ?? '', kind: K.Class, range: rng({ ...val, s: k.s } as ANode), selectionRange: rng(k), tags: [], children };
      });
    },
  });

  // ---------------------------------------------------------------- folding
  monaco.languages.registerFoldingRangeProvider(LANG, {
    provideFoldingRanges(model) {
      const doc = docOfModel(model);
      const root = doc?.jfile?.root;
      if (!root) return [];
      const li = new LineIndex(model.getValue());
      const out: monaco.languages.FoldingRange[] = [];
      const visit = (n: ANode, depth: number) => {
        if (n.k !== 'obj' && n.k !== 'arr') return;
        const a = li.lineAt(n.s), b = li.lineAt(Math.max(n.s, n.e - 1));
        if (b > a) out.push({ start: a + 1, end: b + 1 });
        if (depth > 3) return;
        if (n.k === 'obj') n.vals.forEach((c) => visit(c, depth + 1));
        else n.items.forEach((c) => visit(c, depth + 1));
      };
      visit(root, 0);
      // comment regions: // region ... // endregion
      return out;
    },
  });

  // ---------------------------------------------------------------- inlay hints: beam lengths
  monaco.languages.registerInlayHintsProvider(LANG, {
    provideInlayHints(model, range) {
      if (!settings().editorInlayLengths) return { hints: [], dispose() {} };
      const doc = docOfModel(model);
      const v = ws.vehicle;
      if (!doc || !v) return { hints: [], dispose() {} };
      const s = model.getOffsetAt(range.getStartPosition());
      const e = model.getOffsetAt(range.getEndPosition());
      const hints: monaco.languages.InlayHint[] = [];
      const rows = ws.rowsByFile.get(doc.key) ?? [];
      for (const r of rows) {
        if (r.node.e < s || r.node.s > e) continue;
        const ref = r.refs[0];
        if (ref.kind !== 'beam' || !GOOD_TYPES.has(v.beams[ref.idx].section)) continue;
        const b = v.beams[ref.idx];
        const A = v.nodes[b.a], B = v.nodes[b.b];
        const len = Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z);
        const p = model.getPositionAt(r.node.e);
        hints.push({ label: ` ${len < 0.001 ? '⚠ 0' : fmt(len, 3)}m`, position: { lineNumber: p.lineNumber, column: p.column }, kind: monaco.languages.InlayHintKind.Type, paddingLeft: true });
        if (hints.length > 3000) break;
      }
      return { hints, dispose() {} };
    },
  });

  // ---------------------------------------------------------------- quick fixes
  monaco.languages.registerCodeActionProvider(LANG, {
    provideCodeActions(model, _range, context) {
      const actions: monaco.languages.CodeAction[] = [];
      for (const m of context.markers) {
        if (m.code === 'missing-comma') {
          actions.push({
            title: 'Insert missing comma',
            kind: 'quickfix',
            diagnostics: [m],
            isPreferred: true,
            edit: { edits: [{ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(m.startLineNumber, m.startColumn, m.startLineNumber, m.startColumn), text: ',' } }] },
          });
        }
      }
      const missing = context.markers.filter((m) => m.code === 'missing-comma');
      if (missing.length > 1) {
        actions.push({
          title: `Insert all ${missing.length} missing commas`,
          kind: 'quickfix',
          edit: { edits: missing.map((m) => ({ resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(m.startLineNumber, m.startColumn, m.startLineNumber, m.startColumn), text: ',' } })) },
        });
      }
      return { actions, dispose() {} };
    },
  });

  // ---------------------------------------------------------------- formatting: align tables
  monaco.languages.registerDocumentFormattingEditProvider(LANG, {
    displayName: 'Align JBeam tables',
    provideDocumentFormattingEdits(model) {
      const doc = docOfModel(model);
      if (!doc?.jfile) return [];
      return alignEdits(model, doc, null);
    },
  });
  monaco.languages.registerDocumentRangeFormattingEditProvider(LANG, {
    displayName: 'Align JBeam tables',
    provideDocumentRangeFormattingEdits(model, range) {
      const doc = docOfModel(model);
      if (!doc?.jfile) return [];
      return alignEdits(model, doc, [model.getOffsetAt(range.getStartPosition()), model.getOffsetAt(range.getEndPosition())]);
    },
  });

  // diagnostics follow every assembly
  ws.onAssembled(() => updateAllMarkers());
}

/** Aligns the columns of single-line table rows (whole document or the sections touching a range). */
export function alignEdits(model: monaco.editor.ITextModel, doc: Doc, range: [number, number] | null): monaco.languages.TextEdit[] {
  const text = model.getValue();
  const edits: monaco.languages.TextEdit[] = [];
  const li = new LineIndex(text);
  for (const part of doc.jfile!.parts) {
    for (const [, sec] of part.sections) {
      if (sec.k !== 'arr' || sec.items.length < 2) continue;
      if (range && (sec.e < range[0] || sec.s > range[1])) continue;
      // eligible rows: arrays alone on one line
      const rows: AArr[] = [];
      for (const r of sec.items) {
        if (r.k !== 'arr') continue;
        const l = li.lineAt(r.s);
        if (li.lineAt(r.e - 1) !== l) continue;
        if (r.items.some((c) => c.k === 'arr' && c.items.some((x) => x.k === 'obj' || x.k === 'arr'))) continue;
        rows.push(r);
      }
      if (rows.length < 2) continue;
      const cellsOf = (r: AArr) => r.items.map((c) => text.slice(c.s, c.e).replace(/\s+/g, ' '));
      const widths: number[] = [];
      const numeric: boolean[] = [];
      const all = rows.map(cellsOf);
      all.forEach((cells, ri) => cells.forEach((c, i) => {
        if (i === cells.length - 1) return;
        widths[i] = Math.max(widths[i] ?? 0, c.length);
        if (rows[ri].items[i].k === 'num') numeric[i] = numeric[i] ?? true;
        else numeric[i] = false;
      }));
      rows.forEach((r, ri) => {
        const cells = all[ri];
        const out = cells.map((c, i) => {
          if (i === cells.length - 1) return c;
          const w = widths[i];
          return numeric[i] ? (c + ',').padStart(w + 1) + ' ' : (c + ',').padEnd(w + 2);
        });
        const nt = '[' + out.join('') + ']';
        if (nt !== text.slice(r.s, r.e)) {
          const a = model.getPositionAt(r.s), b = model.getPositionAt(r.e);
          edits.push({ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: nt });
        }
      });
    }
  }
  return edits;
}

export function updateMarkers(d: Doc) {
  const m = d.model;
  if (!m || m.isDisposed()) return;
  const v = ws.vehicle;
  const markers: monaco.editor.IMarkerData[] = [];
  const sevMap = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info, hint: monaco.MarkerSeverity.Hint } as const;
  for (const is of v?.issues ?? []) {
    if (is.file !== d.key || is.s === undefined) continue;
    const a = m.getPositionAt(is.s), b = m.getPositionAt(Math.max(is.s + 1, is.e ?? is.s + 1));
    markers.push({
      severity: sevMap[is.sev],
      message: is.msg,
      code: is.code,
      startLineNumber: a.lineNumber,
      startColumn: a.column,
      endLineNumber: b.lineNumber,
      endColumn: is.code === 'missing-comma' ? a.column : b.column,
    });
    if (markers.length > 2000) break;
  }
  monaco.editor.setModelMarkers(m, 'jbeam', markers);
}

export function updateAllMarkers() {
  for (const d of ws.docs.values()) if (d.model) updateMarkers(d);
}

/** Next free name like the given prefix (f12 -> f13). */
export function suggestName(v: Vehicle, base: string): string {
  const m = /^(.*?)(\d+)([a-z]*)$/i.exec(base);
  if (m) {
    for (let n = +m[2] + 1; n < +m[2] + 1000; n++) {
      const c = m[1] + n + m[3];
      if (!v.nodeIndex.has(c)) return c;
    }
  }
  const prefix = base || settings().namingPrefix;
  for (let n = 1; n < 100000; n++) if (!v.nodeIndex.has(prefix + n)) return prefix + n;
  return prefix;
}
