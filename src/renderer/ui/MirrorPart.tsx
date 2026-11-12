import { useEffect, useMemo, useState } from 'react';
import { FlipHorizontal2, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useSel } from '../state/selection';
import { useUi } from '../state/ui';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { meshes } from '../scene/meshes';
import { mirrorPart, insertPartAfter, swapSideTokens } from '@core/jbeam/mirror';
import { applyRaw } from '../project/ops';
import { Modal } from './Dialogs';

/** The part the mirror button is about: the viewed part, else the target part. */
export function useMirrorCandidate(): { from: string; to: string } | null {
  const scope = useSel((x) => x.scope);
  const target = useWs((x) => x.target);
  useWs((x) => x.version);
  const name = scope.mode === 'part' ? scope.part : target?.part;
  if (!name || !ws.lib) return null;
  const to = swapSideTokens(name);
  if (to === name || ws.lib.get(to)) return null;
  const def = ws.lib.get(name);
  const d = def && ws.doc(def.file);
  if (!d || !d.writable || d.isCommon) return null;
  return { from: name, to };
}

export function MirrorButton() {
  const c = useMirrorCandidate();
  if (!c) return null;
  return (
    <button className="status-mirror" onClick={() => useUi.setState({ dialog: { kind: 'mirrorPart', data: c.from } })} title={`${c.to} does not exist yet — create it by mirroring ${c.from}`}>
      <FlipHorizontal2 size={13} /> Mirror to <span className="mono">{c.to}</span>
    </button>
  );
}

export function MirrorPartDialog({ part, close }: { part: string; close: () => void }) {
  const [indexing, setIndexing] = useState(true);
  useEffect(() => {
    meshes.indexAll().finally(() => setIndexing(false));
  }, []);
  const def = ws.lib?.get(part);
  const doc = def ? ws.doc(def.file) : undefined;
  const result = useMemo(() => {
    if (!def || !doc) return null;
    const v = ws.vehicle;
    const s = settings();
    return mirrorPart(doc.text, def, {
      nodeX: (n) => {
        const i = v?.nodeIndex.get(n);
        return i === undefined ? undefined : v!.nodes[i].x;
      },
      nodeExists: (n) => !!v?.nodeIndex.has(n),
      meshExists: (m) => !!meshes.fileOf(m),
      partExists: (n) => !!ws.lib?.get(n),
      suffixL: s.mirrorSuffixLeft,
      suffixR: s.mirrorSuffixRight,
      centerTol: s.namingCenterTolerance,
    });
  }, [def, doc, indexing]);
  if (!def || !doc) return null;
  const r = result?.report;
  const create = () => {
    if (!result) return;
    const edits = insertPartAfter(doc.text, def, result.text);
    if (applyRaw(`Mirror ${part} → ${result.report.newName}`, new Map([[doc.key, edits]]))) {
      close();
      setTimeout(() => {
        if (ws.focusPart(result.report.newName)) toast('ok', `Created ${result.report.newName}`);
        else toast('ok', `Created ${result.report.newName} in ${doc.name} (no active slot accepts it yet)`);
      }, 50);
    }
  };
  return (
    <Modal title={`Mirror ${part}`} onClose={close} width={620} footer={<>
      <span className="grow dim small-text">Inserted right after <span className="mono">{part}</span> in <span className="mono">{doc.name}</span> · undo with Ctrl+Z</span>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!result} onClick={create}>Create {r?.newName ?? ''}</button>
    </>}>
      {indexing && <div className="row dim" style={{ marginBottom: 8 }}><Loader2 size={14} className="spin" /> Looking for mirrored flexbody meshes…</div>}
      {!r ? null : (
        <div className="mirror-report">
          <div className="mirror-line ok"><CheckCircle2 size={14} /> {r.nodesRenamed} nodes renamed l↔r with X mirrored{r.centerNodes ? `, ${r.centerNodes} centre nodes kept` : ''}</div>
          <div className="mirror-line ok"><CheckCircle2 size={14} /> {r.refsMirrored} links to other parts' nodes mirrored</div>
          <div className="mirror-line ok"><CheckCircle2 size={14} /> {r.trisFlipped} triangles flipped (winding)</div>
          <div className="mirror-line ok"><CheckCircle2 size={14} /> {r.stringsSwapped} names swapped (slot types, slots, groups, deform/break groups, trigger ids, display name){r.numbersMirrored ? `; ${r.numbersMirrored} positions mirrored` : ''}</div>
          {r.meshesSwapped.length > 0 && <div className="mirror-line ok"><CheckCircle2 size={14} /> Flexbodies: {r.meshesSwapped.join(', ')}</div>}
          {r.meshesKept.length > 0 && <div className="mirror-line warn"><AlertTriangle size={14} /> No mirrored mesh found, kept as is: <span className="mono">{r.meshesKept.join(', ')}</span></div>}
          {r.refsKept.length > 0 && <div className="mirror-line warn"><AlertTriangle size={14} /> Links kept (no mirror node exists): <span className="mono">{r.refsKept.slice(0, 20).join(', ')}{r.refsKept.length > 20 ? '…' : ''}</span></div>}
          {r.conflicts.length > 0 && <div className="mirror-line warn"><AlertTriangle size={14} /> Already defined elsewhere (the new part redefines them): <span className="mono">{r.conflicts.slice(0, 20).join(', ')}</span></div>}
          {r.warnings.map((w, i) => <div key={i} className="mirror-line warn"><AlertTriangle size={14} /> {w}</div>)}
        </div>
      )}
    </Modal>
  );
}
