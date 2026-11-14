/**
 * A file changed on disk while it has unsaved edits here, and both touched the same lines.
 * Everything else is already merged; for each overlapping block the user keeps their edit, takes
 * the disk version, or keeps both (theirs after mine), like resolving a git conflict.
 */
import { useMemo, useState } from 'react';
import { ws } from '../project/workspace';
import { merge3, mergedText, type Resolution } from '@core/merge';
import { toast } from '../state/toast';
import { Modal } from './Dialogs';

interface Data {
  doc: string;
  base: string;
  ours: string;
  theirs: string;
}

const CONTEXT = 2;

export function MergeDialog({ data, close }: { data: Data; close: () => void }) {
  const d = ws.doc(data.doc);
  const r = useMemo(() => merge3(data.base, data.ours, data.theirs), [data]);
  const [pick, setPick] = useState<Resolution[]>(() => Array(r.conflicts).fill('ours'));
  const blocks = useMemo(() => {
    const out: Array<{ line: number; before: string[]; after: string[]; ours: string[]; theirs: string[] }> = [];
    let line = 1;
    r.chunks.forEach((ch, i) => {
      if (ch.kind === 'same') {
        line += ch.lines.length;
        return;
      }
      const prev = r.chunks[i - 1];
      const next = r.chunks[i + 1];
      out.push({
        line,
        before: prev?.kind === 'same' ? prev.lines.slice(-CONTEXT) : [],
        after: next?.kind === 'same' ? next.lines.slice(0, CONTEXT) : [],
        ours: ch.ours,
        theirs: ch.theirs,
      });
      line += ch.ours.length;
    });
    return out;
  }, [r]);
  const auto = r.chunks.length - r.conflicts;
  const done = (msg: string) => {
    close();
    toast('ok', msg, undefined, 2500);
    setTimeout(() => ws.nextMerge(), 0);
  };
  const apply = (choose: (i: number) => Resolution) => {
    if (!d) return close();
    ws.applyMerge(d, mergedText(r, choose), data.theirs);
    done(`Merged ${d.name}. Your edits are still unsaved.`);
  };
  const keepMine = () => {
    close();
    toast('warn', `${d?.name ?? 'File'}: disk changes not merged. Saving will overwrite them.`, undefined, 5000);
    setTimeout(() => ws.nextMerge(), 0);
  };
  const lines = (ls: string[], cls: string) => ls.map((l, i) => <div key={i} className={'mg-line ' + cls}>{l.replace(/\r?\n$/, '') || ' '}</div>);
  return (
    <Modal
      title={`${d?.name ?? data.doc} changed on disk`}
      onClose={keepMine}
      width={880}
      footer={<>
        <button className="btn" onClick={keepMine} data-tip="Ignore the disk changes for now" data-tip-pos="top">Keep my version</button>
        <button className="btn" onClick={() => apply(() => 'theirs')}>Take disk for all</button>
        <div className="grow" />
        <button className="btn primary" onClick={() => apply((i) => pick[i])}>Merge</button>
      </>}
    >
      <div className="mg-intro">
        You have unsaved edits in this file and another program changed it on disk.
        {auto > 0 ? ' The changes that do not overlap are merged already. ' : ' '}
        Pick what to keep where both changed the same lines:
      </div>
      <div className="mg-list">
        {blocks.map((b, i) => (
          <div key={i} className="mg-block">
            <div className="mg-head">
              <span className="dim">Line {b.line}</span>
              <div className="grow" />
              <div className="segmented small">
                {([['ours', 'Mine'], ['theirs', 'Disk'], ['both', 'Both']] as const).map(([v, l]) => (
                  <button key={v} className={'seg' + (pick[i] === v ? ' active' : '')} onClick={() => setPick(pick.map((x, j) => (j === i ? v : x)))}>{l}</button>
                ))}
              </div>
            </div>
            <div className="mg-cols">
              <div className={'mg-col' + (pick[i] === 'ours' || pick[i] === 'both' ? ' on' : '')}>
                <div className="mg-col-title">Mine (unsaved)</div>
                {lines(b.before, 'ctx')}
                {b.ours.length ? lines(b.ours, 'chg') : <div className="mg-line chg empty">(deleted)</div>}
                {lines(b.after, 'ctx')}
              </div>
              <div className={'mg-col' + (pick[i] === 'theirs' || pick[i] === 'both' ? ' on' : '')}>
                <div className="mg-col-title">On disk</div>
                {lines(b.before, 'ctx')}
                {b.theirs.length ? lines(b.theirs, 'chg') : <div className="mg-line chg empty">(deleted)</div>}
                {lines(b.after, 'ctx')}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
