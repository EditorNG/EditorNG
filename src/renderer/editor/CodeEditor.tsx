import { useEffect, useRef } from 'react';
import { X, Lock, Circle } from 'lucide-react';
import { monaco } from '../lib/monaco';
import { ws, useWs } from '../project/workspace';
import { useUi, openTab, closeTab } from '../state/ui';
import { useSettings, settings } from '../state/settings';
import { useSel, emptySel, beamKey, triKey, rowKey, type Sel } from '../state/selection';
import { updateMarkers, contextAt } from './jbeamLang';

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
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
        const row = (v.tables.get('triggers2') ?? [])[r.idx];
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
  useWs((x) => x.version);

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
    editor.onDidChangeCursorSelection(() => {
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
    editor.addAction({
      id: 'editorng.align',
      label: 'Align table columns',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      run: (ed) => ed.getAction('editor.action.formatDocument')?.run(),
    });
    return () => {
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
  }, [active]);

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
