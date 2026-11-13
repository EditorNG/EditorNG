import { monaco } from '../lib/monaco';

/**
 * The code insertion point: where tools (add node, beam chain, triangles, placers, import…) put new rows.
 * It follows the user's own clicks and typing in the code editor, not programmatic cursor moves (selecting
 * something in 3D reveals its row, which must not steal the spot). It is tracked as a model decoration so it
 * survives edits, and it grows over rows inserted at it, so consecutive additions continue in order.
 */
let model: monaco.editor.ITextModel | null = null;
let tracker: string[] = [];
let visual: string[] = [];
let listener: monaco.IDisposable | null = null;

const TRACK: monaco.editor.IModelDecorationOptions = { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges };

function trackedRange(): monaco.Range | null {
  if (!model || model.isDisposed() || !tracker.length) return null;
  return model.getDecorationRange(tracker[0]);
}

function refreshVisual() {
  if (!model || model.isDisposed()) return;
  const r = trackedRange();
  const line = r?.endLineNumber;
  visual = model.deltaDecorations(
    visual,
    line
      ? [
          {
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              linesDecorationsClassName: 'code-insert-mark',
              linesDecorationsTooltip: 'Insert point: tools add new rows below this line (when it is inside the section they write to)',
            },
          },
        ]
      : [],
  );
}

function clear() {
  if (model && !model.isDisposed()) {
    model.deltaDecorations([...tracker, ...visual], []);
  }
  listener?.dispose();
  listener = null;
  tracker = [];
  visual = [];
  model = null;
}

/** Places the insertion point at an offset of a model (an empty range that grows over text typed at it). */
export function setInsertMark(m: monaco.editor.ITextModel, offset: number) {
  if (m !== model) {
    clear();
    model = m;
    listener = m.onDidChangeContent(() => queueMicrotask(collapse));
  }
  const p = m.getPositionAt(offset);
  tracker = m.deltaDecorations(tracker, [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), options: TRACK }]);
  refreshVisual();
}

/** After an edit, shrink the tracker to its end so it keeps marking a single line. */
function collapse() {
  const r = trackedRange();
  if (!model || !r) return;
  if (!r.isEmpty()) {
    tracker = model.deltaDecorations(tracker, [{ range: new monaco.Range(r.endLineNumber, r.endColumn, r.endLineNumber, r.endColumn), options: TRACK }]);
  }
  refreshVisual();
}

/** The insertion point's offset in that model, or null when there is none there. */
export function insertMarkOffset(m: monaco.editor.ITextModel | undefined): number | null {
  if (!m || m !== model) return null;
  const r = trackedRange();
  return r ? m.getOffsetAt(r.getEndPosition()) : null;
}

/** Moves the insertion point onto the start of rows about to be inserted at `offset`, so it grows over them. */
export function moveInsertMark(m: monaco.editor.ITextModel, offset: number) {
  if (m !== model) return;
  const p = m.getPositionAt(offset);
  tracker = m.deltaDecorations(tracker, [{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), options: TRACK }]);
}
