import { useEffect, useRef, useState } from 'react';
import { X, Lock, Circle } from 'lucide-react';
import { monaco } from '../lib/monaco';
import { ws, useWs } from '../project/workspace';
import { useUi, openTab, closeTab } from '../state/ui';
import { useSettings, settings } from '../state/settings';
import { useSel, emptySel, beamKey, triKey, rowKey, resolveSel, addToSel, setSel, type Sel } from '../state/selection';
import { pathAt } from '@core/sjson';
import { updateMarkers, contextAt } from './jbeamLang';
import { openMenu } from '../ui/Menu';
import { showReferences } from '../ui/Tier2';
import { api } from '../lib/api';
import * as ops from '../project/ops';

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let selDecos: monaco.editor.IEditorDecorationsCollection | null = null;

/** "part › section › row" at an offset of a jbeam document. */
function crumbsAt(docKey: string, offset: number): string[] {
  const d = ws.doc(docKey);
  if (!d?.jfile?.root) return [];
  const path = pathAt(d.jfile.root, offset);
  const out: string[] = [];
  // root obj → part (key) → section (key) → row (index)
  if (path[1]?.key) out.push(path[1].key);
  if (path[2]?.key) out.push(path[2].key);
  const row = path[3]?.node;
  if (row && row.k === 'arr' && path[3].index !== undefined) {
    const first = row.items[0];
    const isHeader = path[3].index === 0 && row.items.every((x) => x.k === 'str');
    out.push(isHeader ? 'header' : first && first.k === 'str' ? first.v : `row ${path[3].index}`);
  } else if (path[3]?.key) out.push(path[3].key);
  return out;
}

/** Rows of the 3D selection in the open file: the selected rows strongly, rows of attached beams faintly. */
function decorateSelection() {
  if (!editor) return;
  const m = editor.getModel();
  const v = ws.vehicle;
  if (!selDecos) selDecos = editor.createDecorationsCollection();
  const d = m ? [...ws.docs.values()].find((x) => x.model === m) : undefined;
  if (!m || !v || !d) {
    selDecos.clear();
    return;
  }
  const si = resolveSel(v, useSel.getState().sel);
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  const add = (row: { src: { file: string; node: { s: number; e: number } } } | undefined, strong: boolean) => {
    if (!row || row.src.file.toLowerCase() !== d.key.toLowerCase()) return;
    const a = m.getPositionAt(row.src.node.s), b = m.getPositionAt(row.src.node.e);
    decos.push({
      range: new monaco.Range(a.lineNumber, 1, b.lineNumber, 1),
      options: { isWholeLine: true, className: strong ? 'code-sel-line' : 'code-rel-line', linesDecorationsClassName: strong ? 'code-sel-bar' : 'code-rel-bar' },
    });
  };
  if (si.nodes.size <= 200) for (const i of si.nodes) add(v.nodes[i].row, true);
  for (const i of si.beams) add(v.beams[i].row, true);
  for (const i of si.tris) add(v.tris[i].row, true);
  for (const i of si.triggers) add(v.triggers[i], true);
  for (const i of si.flex) add(v.flexbodies[i].row, true);
  for (const i of si.props) add(v.props[i].row, true);
  if (si.nodes.size > 0 && si.nodes.size <= 16) {
    v.beams.forEach((b, i) => {
      if (!si.beams.has(i) && (si.nodes.has(b.a) || si.nodes.has(b.b))) add(b.row, false);
    });
  }
  selDecos.set(decos.slice(0, 2000));
}
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
let suppressCursor = 0;

export function getEditor() {
  return editor;
}

/** Opens a document and selects a range (offsets). */
export function revealRange(docKey: string, s: number, e: number, focus = false) {
  const d = ws.doc(docKey);
  if (!d) return;
  openTab(d.key);
  // the editor may need a tick to switch models
  requestAnimationFrame(() => {
    if (!editor) return;
    const m = ws.ensureModel(d);
    if (editor.getModel() !== m) editor.setModel(m);
    const a = m.getPositionAt(s), b = m.getPositionAt(e);
    suppressCursor++;
    editor.setSelection(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column));
    editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), monaco.editor.ScrollType.Smooth);
    setTimeout(() => suppressCursor--, 50);
    if (focus) editor.focus();
  });
}

function editorOptions(): monaco.editor.IEditorOptions {
  const s = settings();
  return {
    fontSize: s.editorFontSize,
    fontFamily: s.editorFontFamily,
    fontLigatures: true,
    minimap: { enabled: s.editorMinimap, renderCharacters: false, scale: 1 },
    wordWrap: s.editorWordWrap ? 'on' : 'off',
    stickyScroll: { enabled: s.editorStickyScroll },
    renderWhitespace: s.editorRenderWhitespace ? 'all' : 'selection',
    renderLineHighlight: s.editorLineHighlight ? 'line' : 'none',
    hover: { delay: s.editorHoverDelay },
    inlayHints: { enabled: s.editorInlayLengths ? 'on' : 'off', fontSize: Math.max(9, s.editorFontSize - 2) },
  };
}

function highlightFromCursor() {
  if (!editor || !settings().editorSyncCursor) return;
  const m = editor.getModel();
  if (!m) return;
  const d = [...ws.docs.values()].find((x) => x.model === m);
  const v = ws.vehicle;
  if (!d || !v) return;
  const sels = editor.getSelections() ?? [];
  const hl: Sel = emptySel();
  for (const sel of sels) {
    const s = m.getOffsetAt(sel.getStartPosition());
    const e = m.getOffsetAt(sel.getEndPosition());
    const refs = ws.elementsInRange(d.key, s, Math.max(s, e));
    for (const r of refs) {
      if (r.kind === 'node') hl.nodes.add(v.nodes[r.idx].name);
      else if (r.kind === 'beam') {
        const b = v.beams[r.idx];
        hl.beams.add(beamKey(v.nodes[b.a].name, v.nodes[b.b].name));
      } else if (r.kind === 'tri') {
        const t = v.tris[r.idx];
        hl.tris.add(triKey(v.nodes[t.a].name, v.nodes[t.b].name, v.nodes[t.c].name));
      } else if (r.kind === 'flex') {
        const f = v.flexbodies[r.idx];
        hl.flex.add(rowKey(f.row.src.file, f.row.src.node.s));
        for (const n of v.nodes) if (n.groups.some((g) => f.groups.includes(g))) hl.nodes.add(n.name);
      } else if (r.kind === 'prop') {
        const p = v.props[r.idx];
        hl.props.add(rowKey(p.row.src.file, p.row.src.node.s));
        for (const k of [p.idRef, p.idX, p.idY]) if (k >= 0) hl.nodes.add(v.nodes[k].name);
      } else if (r.kind === 'trigger') {
        const row = v.triggers[r.idx];
        if (row) {
          hl.triggers.add(rowKey(row.src.file, row.src.node.s));
          for (const k of ['idRef:', 'idX:', 'idY:']) if (typeof row.v[k] === 'string') hl.nodes.add(row.v[k]);
        }
      } else if (r.kind === 'wheel') {
        const w = v.wheels[r.idx];
        hl.nodes.add(v.nodes[w.n1].name);
        hl.nodes.add(v.nodes[w.n2].name);
      }
    }
    // node name under the cursor (e.g. inside a beam row) highlights that node
    if (s === e && d.jfile) {
      const ctx = contextAt(d, s);
      if (ctx.leaf?.k === 'str' && v.nodeIndex.has(ctx.leaf.v)) hl.nodes.add(ctx.leaf.v);
      // whole section highlight when the cursor is on the section key
      if (ctx.onKey && ctx.path.length === 3 && ctx.part && ctx.section) {
        const sec = ctx.part.sections.get(ctx.section);
        if (sec) for (const r of ws.elementsInRange(d.key, sec.s, sec.e)) {
          if (r.kind === 'node') hl.nodes.add(v.nodes[r.idx].name);
          else if (r.kind === 'beam') hl.beams.add(beamKey(v.nodes[v.beams[r.idx].a].name, v.nodes[v.beams[r.idx].b].name));
          else if (r.kind === 'tri') {
            const t = v.tris[r.idx];
            hl.tris.add(triKey(v.nodes[t.a].name, v.nodes[t.b].name, v.nodes[t.c].name));
          }
        }
      }
      // target part follows the cursor
      if (ctx.part && d.writable && !d.isCommon) ws.setTarget(d.key, ctx.part.name);
    }
  }
  useSel.setState({ highlight: hl });
}

export function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  const tabs = useUi((s) => s.tabs);
  const active = useUi((s) => s.activeTab);
  const s = useSettings((x) => x.s);
  const version = useWs((x) => x.version);
  const sel = useSel((x) => x.sel);
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const crumbRef = useRef<(c: string[]) => void>(setCrumbs);
  crumbRef.current = setCrumbs;

  useEffect(() => {
    if (!host.current) return;
    editor = monaco.editor.create(host.current, {
      ...editorOptions(),
      automaticLayout: true,
      theme: 'editorng-dark',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      mouseWheelZoom: true,
      folding: true,
      showFoldingControls: 'mouseover',
      fixedOverflowWidgets: true,
      padding: { top: 6 },
      'semanticHighlighting.enabled': false,
      formatOnPaste: false,
      quickSuggestions: { strings: true, other: true, comments: false },
      suggest: { showWords: false },
    } as any);
    let t: ReturnType<typeof setTimeout> | null = null;
    editor.onDidChangeCursorSelection((e) => {
      const mm = editor?.getModel();
      const dd = mm ? [...ws.docs.values()].find((x) => x.model === mm) : undefined;
      if (mm && dd) crumbRef.current(crumbsAt(dd.key, mm.getOffsetAt(e.selection.getStartPosition())));
      if (suppressCursor) return;
      if (t) clearTimeout(t);
      t = setTimeout(highlightFromCursor, 60);
    });
    editor.onDidBlurEditorText(() => {
      if (settings().autoSave === 'onFocusChange') ws.saveAll();
    });
    // remember Ctrl+S inside the editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const k = useUi.getState().activeTab;
      if (k) ws.save(k);
    });
    const docOf = (ed: monaco.editor.ICodeEditor) => {
      const mm = ed.getModel();
      return mm ? [...ws.docs.values()].find((x) => x.model === mm) : undefined;
    };
    /** elements produced by the rows under the selection (or cursor) */
    const refsAt = (ed: monaco.editor.ICodeEditor) => {
      const mm = ed.getModel();
      const dd = docOf(ed);
      const sel = ed.getSelection();
      if (!mm || !dd || !sel) return [];
      return ws.elementsInRange(dd.key, mm.getOffsetAt(sel.getStartPosition()), mm.getOffsetAt(sel.getEndPosition()));
    };
    const selectRefs = (ed: monaco.editor.ICodeEditor) => {
      const v = ws.vehicle;
      if (!v) return;
      const s2 = emptySel();
      for (const r of refsAt(ed)) addToSel(v, s2, r.kind as any, r.idx);
      // a node name under the cursor counts too
      const dd = docOf(ed);
      const mm = ed.getModel();
      const pos = ed.getPosition();
      if (dd && mm && pos) {
        const ctx = contextAt(dd, mm.getOffsetAt(pos));
        if (ctx.leaf?.k === 'str' && v.nodeIndex.has(ctx.leaf.v)) s2.nodes.add(ctx.leaf.v);
      }
      setSel(s2);
    };
    editor.addAction({
      id: 'editorng.select3d',
      label: 'Select in 3D',
      contextMenuGroupId: '0_editorng',
      contextMenuOrder: 1,
      run: (ed) => selectRefs(ed),
    });
    editor.addAction({
      id: 'editorng.gotoNode',
      label: 'Go to node definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: '0_editorng',
      contextMenuOrder: 2,
      run: (ed) => {
        const v = ws.vehicle;
        const dd = docOf(ed);
        const mm = ed.getModel();
        const pos = ed.getPosition();
        if (!v || !dd || !mm || !pos) return;
        const ctx = contextAt(dd, mm.getOffsetAt(pos));
        const i = ctx.leaf?.k === 'str' ? v.nodeIndex.get(ctx.leaf.v) : undefined;
        if (i === undefined) return;
        const r = v.nodes[i].row;
        revealRange(r.src.file, r.src.node.s, r.src.node.e, true);
      },
    });
    editor.addAction({
      id: 'editorng.findRefs',
      label: 'Find node references',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: '0_editorng',
      contextMenuOrder: 2.5,
      run: (ed) => {
        const v = ws.vehicle;
        const dd = docOf(ed);
        const mm = ed.getModel();
        const pos = ed.getPosition();
        if (!dd || !mm || !pos) return;
        const ctx = contextAt(dd, mm.getOffsetAt(pos));
        let name = ctx.leaf?.k === 'str' ? ctx.leaf.v : null;
        if (name && v && !v.nodeIndex.has(name)) name = null;
        if (!name) {
          const r = refsAt(ed).find((x) => x.kind === 'node');
          if (r && v) name = v.nodes[r.idx].name;
        }
        if (name) showReferences(name);
      },
    });
    editor.addAction({
      id: 'editorng.mirrorRow',
      label: 'Mirror to the other side',
      contextMenuGroupId: '0_editorng',
      contextMenuOrder: 3,
      run: (ed) => {
        const refs = refsAt(ed);
        if (refs.some((r) => r.kind === 'trigger')) {
          for (const r of refs) if (r.kind === 'trigger') ops.mirrorTrigger(r.idx);
          return;
        }
        selectRefs(ed);
        ops.mirrorSelection();
      },
    });
    editor.addAction({
      id: 'editorng.align',
      label: 'Align table columns',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      run: (ed) => ed.getAction('editor.action.formatDocument')?.run(),
    });
    return () => {
      selDecos = null;
      editor?.dispose();
      editor = null;
    };
  }, []);

  useEffect(() => {
    editor?.updateOptions(editorOptions());
  }, [s]);

  // switch model when the active tab changes
  useEffect(() => {
    if (!editor) return;
    const prev = editor.getModel();
    const prevDoc = prev ? [...ws.docs.values()].find((d) => d.model === prev) : undefined;
    if (prevDoc) viewStates.set(prevDoc.key, editor.saveViewState());
    const d = ws.doc(active);
    if (!d) {
      editor.setModel(null);
      return;
    }
    const m = ws.ensureModel(d);
    if (editor.getModel() !== m) {
      editor.setModel(m);
      const vs = viewStates.get(d.key);
      if (vs) editor.restoreViewState(vs);
    }
    m.updateOptions({ tabSize: settings().editorTabSize, insertSpaces: !/\n\t/.test(d.text) });
    editor.updateOptions({ readOnly: !d.writable, readOnlyMessage: { value: `${d.name} is read-only (${d.source}). Use "Make editable copy" in the explorer.` } });
    updateMarkers(d);
    // in file scope, the 3D view follows the code tab
    const sc = useSel.getState().scope;
    if (sc.mode === 'file' && sc.file !== d.key && ws.vehicle?.parts.some((p) => p.def.file === d.key)) ws.setScope({ mode: 'file', file: d.key });
  }, [active]);

  useEffect(() => {
    decorateSelection();
  }, [sel, active, version]);

  // drop tabs whose documents vanished (vehicle switch)
  useEffect(() => {
    const st = useUi.getState();
    const keep = st.tabs.filter((k) => ws.doc(k));
    if (keep.length !== st.tabs.length) useUi.setState({ tabs: keep, activeTab: keep.includes(st.activeTab ?? '') ? st.activeTab : keep[0] ?? null });
  });

  return (
    <div className="code-editor">
      <div className="tabs">
        {tabs.map((k) => {
          const d = ws.doc(k);
          if (!d) return null;
          const dirty = ws.isDirty(d);
          return (
            <div
              key={k}
              className={'tab' + (k === active ? ' active' : '')}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(k);
                } else openTab(k);
              }}
              title={`${d.vpath}\n${d.source}${d.writable ? '' : ' (read-only)'}`}
              onContextMenu={(e) => {
                e.preventDefault();
                const others = tabs.filter((t) => t !== k);
                openMenu(e.clientX, e.clientY, [
                  { label: 'Close', run: () => closeTab(k) },
                  { label: 'Close others', disabled: others.length ? false : 'No other tabs', run: () => others.forEach((t) => closeTab(t)) },
                  { label: 'Close all', run: () => [...tabs].forEach((t) => closeTab(t)) },
                  'sep',
                  { label: 'Show this file in 3D', disabled: ws.vehicle?.parts.some((p) => p.def.file === d.key) ? false : 'No active part in this file', run: () => ws.setScope({ mode: 'file', file: d.key }) },
                  { label: 'Save', key: 'Ctrl+S', disabled: d.writable && dirty ? false : 'No unsaved changes', run: () => ws.save(d.key) },
                  { label: 'Compare with backup…', disabled: d.writable && d.ref.real ? false : 'Only for editable files on disk', run: () => useUi.setState({ dialog: { kind: 'diff', data: { doc: d.key, against: 'backup' } } }) },
                  { label: 'Compare with original…', disabled: d.writable ? false : 'This is the original', run: () => useUi.setState({ dialog: { kind: 'diff', data: { doc: d.key, against: 'original' } } }) },
                  { label: 'Reveal in Explorer', disabled: d.ref.real ? false : 'Inside a zip', run: () => d.ref.real && api.reveal(d.ref.real) },
                  { label: 'Copy path', run: () => navigator.clipboard.writeText(d.ref.real ?? d.vpath) },
                ]);
              }}
            >
              {!d.writable && <Lock size={11} className="faint" />}
              <span className="ellipsis">{d.name}</span>
              <button
                className={'tab-close' + (dirty ? ' dirty' : '')}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(k);
                }}
                aria-label="Close tab"
              >
                {dirty ? <Circle size={8} fill="currentColor" className="dot" /> : null}
                <X size={13} className="x" />
              </button>
            </div>
          );
        })}
      </div>
      {active && (
        <div className="code-crumbs">
          {crumbs.length ? crumbs.map((c, i) => (
            <span key={i} className={i === crumbs.length - 1 ? 'mono strong' : 'mono'}>{i > 0 && <span className="crumb-sep"> › </span>}{c}</span>
          )) : <span className="faint">{ws.doc(active)?.name}</span>}
        </div>
      )}
      <div className="editor-host" ref={host} />
      {!active && (
        <div className="editor-empty">
          <div className="dim">Click any node, beam or triangle to jump to its line,</div>
          <div className="dim">or open a file from the explorer.</div>
        </div>
      )}
    </div>
  );
}
