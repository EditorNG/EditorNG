/**
 * Daily-work helpers: find references, start page + recent items + session restore,
 * compare with backup / original, and packing a mod with a pre-release check.
 */
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { AlertCircle, AlertTriangle, Info, Car, FileCode2, FolderOpen, FilePlus2, Package, Link2 } from 'lucide-react';
import { api } from '../lib/api';
import { monaco } from '../lib/monaco';
import { ws, useWs } from '../project/workspace';
import * as ops from '../project/ops';
import { useUi } from '../state/ui';
import { useSel, resolveSel } from '../state/selection';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { revealRange } from '../editor/CodeEditor';
import { findNodeTokens } from '@core/jbeam/edit';
import { pathAt } from '@core/sjson';
import { Modal } from './Dialogs';
import { openMenu } from './Menu';
import { command } from './commands';
import { getViewport } from '../scene/ViewportPanel';

// ------------------------------------------------------------------------------------------
// find references (5.8)
// ------------------------------------------------------------------------------------------

export interface NodeRef {
  file: string;
  docName: string;
  part: string;
  section: string;
  s: number;
  e: number;
  line: number;
  text: string;
  writable: boolean;
  /** the node's own definition row */
  definition: boolean;
}

/** Every place a node name is used: rows of any section, slot variables, other files. */
export function findReferences(name: string): NodeRef[] {
  const v = ws.vehicle;
  const defIdx = v?.nodeIndex.get(name);
  const defRow = defIdx !== undefined ? v!.nodes[defIdx].row : null;
  const out: NodeRef[] = [];
  for (const d of ws.docs.values()) {
    if (!d.jfile || d.lang !== 'jbeam' || !d.text.includes(name)) continue;
    const text = d.text;
    for (const p of d.jfile.parts) {
      // same-named nodes of unrelated vehicles (common folder) are not references
      if (v && !v.partsByName.has(p.name) && (d.isCommon || !d.writable)) continue;
      for (const t of findNodeTokens(p, name)) {
        const path = d.jfile.root ? pathAt(d.jfile.root, t.s) : [];
        const ls = text.lastIndexOf('\n', t.s - 1) + 1;
        const le = text.indexOf('\n', t.s);
        let line = 1;
        for (let i = text.indexOf('\n'); i >= 0 && i < t.s; i = text.indexOf('\n', i + 1)) line++;
        out.push({
          file: d.key, docName: d.name, part: p.name, section: path[2]?.key ?? '', s: t.s, e: t.e, line,
          text: text.slice(ls, le < 0 ? undefined : le).trim().slice(0, 160), writable: d.writable && !d.isCommon,
          definition: !!defRow && defRow.src.file.toLowerCase() === d.key.toLowerCase() && t.s >= defRow.src.node.s && t.s < defRow.src.node.e,
        });
      }
    }
  }
  return out.sort((a, b) => Number(b.definition) - Number(a.definition) || a.docName.localeCompare(b.docName) || a.s - b.s);
}

const useRefs = create<{ name: string | null; list: NodeRef[] }>(() => ({ name: null, list: [] }));

export function showReferences(name: string) {
  useRefs.setState({ name, list: findReferences(name) });
  useUi.setState({ bottom: true, bottomTab: 'refs' });
}

export function ReferencesTab() {
  const { name, list } = useRefs();
  useWs((x) => x.version);
  if (!name) return <div className="empty-hint">Right-click a node → Find references (or Shift+F12 in code).</div>;
  const byPart = new Map<string, NodeRef[]>();
  for (const r of list) (byPart.get(r.part) ?? byPart.set(r.part, []).get(r.part)!).push(r);
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="bpanel-tools">
        <span><span className="mono strong-text">{name}</span> <span className="faint">· {list.length} use{list.length === 1 ? '' : 's'} in {byPart.size} part{byPart.size === 1 ? '' : 's'}</span></span>
        <div className="grow" />
        <button className="btn small ghost" onClick={() => showReferences(name)}>Refresh</button>
      </div>
      <div className="list-scroll">
        {[...byPart].map(([part, refs]) => (
          <div key={part}>
            <div className="group-label">{part} <span className="faint">{refs[0].docName}</span></div>
            {refs.map((r, k) => (
              <button key={k} className="problem" onClick={() => revealRange(r.file, r.s, r.e, true)}>
                <span className="faint mono log-t">{r.line}</span>
                <span className="ref-sec">{r.definition ? 'definition' : r.section || 'slot'}</span>
                <span className="ellipsis grow mono">{r.text}</span>
                {!r.writable && <span className="faint small-text">read-only</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Delete with a warning when the selected nodes are still used by other parts. */
export function deleteWithCheck() {
  const v = ws.vehicle;
  if (!v) return;
  const si = resolveSel(v, useSel.getState().sel);
  const related = settings().deleteRelated;
  const external: Array<{ node: string; ref: NodeRef }> = [];
  for (const i of si.nodes) {
    const n = v.nodes[i];
    for (const r of findReferences(n.name)) {
      if (r.definition || r.part === n.row.part.def.name) continue;
      // beams / triangles using the node go with it when "delete related" is on
      if (related && (r.section === 'beams' || r.section === 'triangles' || r.section === 'quads')) continue;
      external.push({ node: n.name, ref: r });
    }
  }
  if (!external.length) {
    ops.deleteSelection();
    return;
  }
  useUi.setState({ dialog: { kind: 'deleteRefs', data: external } });
}

export function DeleteRefsDialog({ close, data }: { close: () => void; data: Array<{ node: string; ref: NodeRef }> }) {
  const nodes = [...new Set(data.map((d) => d.node))];
  return (
    <Modal title="Still used elsewhere" onClose={close} width={560} footer={<>
      <button className="btn" onClick={() => { close(); showReferences(nodes[0]); }}>Show references</button>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn danger" onClick={() => { close(); ops.deleteSelection(); }}>Delete anyway</button>
    </>}>
      <div style={{ marginBottom: 8 }}>
        {nodes.length === 1 ? <>Node <b className="mono">{nodes[0]}</b> is</> : <>{nodes.length} nodes are</>} used by other parts. Those rows will point at a node that no longer exists.
      </div>
      <div className="sym-list mono">
        {data.slice(0, 14).map((d, i) => <div key={i}>{d.node} ← {d.ref.part} › {d.ref.section || 'slot'} <span className="faint">(line {d.ref.line})</span></div>)}
        {data.length > 14 && <div className="faint">…and {data.length - 14} more</div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------
// recent items, start page, session restore (5.9)
// ------------------------------------------------------------------------------------------

export const useRecent = create<{ vehicles: string[]; files: string[] }>(() => ({ vehicles: [], files: [] }));

export async function loadRecent() {
  const st = await api.stateLoad();
  useRecent.setState({ vehicles: st.recentVehicles ?? [], files: st.recentFiles ?? [] });
}

async function saveRecent() {
  const cur = await api.stateLoad();
  const r = useRecent.getState();
  await api.stateSave({ ...cur, recentVehicles: r.vehicles, recentFiles: r.files });
}

export function addRecentVehicle(model: string) {
  const v = useRecent.getState().vehicles.filter((x) => x.toLowerCase() !== model.toLowerCase());
  useRecent.setState({ vehicles: [model, ...v].slice(0, 8) });
  saveRecent();
}

export function addRecentFiles(paths: string[]) {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  const f = useRecent.getState().files.filter((x) => !set.has(x.toLowerCase()));
  useRecent.setState({ files: [...paths, ...f].slice(0, 8) });
  saveRecent();
}

interface Session {
  scope?: any;
  tabs?: string[];
  activeTab?: string | null;
  camera?: { pos: number[]; target: number[]; ortho: boolean };
}

/** Saves scope, open tabs and camera of the open vehicle (debounced by the caller). */
export async function saveSession() {
  const model = ws.model;
  const vp = getViewport();
  if (!model || !vp) return;
  const ui = useUi.getState();
  const s: Session = { scope: useSel.getState().scope, tabs: ui.tabs, activeTab: ui.activeTab, camera: vp.getCameraState() };
  const cur = await api.stateLoad();
  await api.stateSave({ ...cur, sessions: { ...(cur.sessions ?? {}), [model.toLowerCase()]: s } });
}

/** Restores what saveSession stored for this vehicle (after it was opened). */
export async function restoreSession(model: string) {
  const cur = await api.stateLoad();
  const s: Session | undefined = cur.sessions?.[model.toLowerCase()];
  if (!s) return;
  const tabs = (s.tabs ?? []).filter((t) => ws.doc(t));
  if (tabs.length) useUi.setState({ tabs, activeTab: s.activeTab && tabs.includes(s.activeTab) ? s.activeTab : tabs[0] });
  const v = ws.vehicle;
  const sc = s.scope;
  if (v && sc) {
    if (sc.mode === 'part' && v.partsByName.has(sc.part)) ws.focusPart(sc.part);
    else if (sc.mode === 'file' && v.parts.some((p) => p.def.file === sc.file)) ws.setScope(sc);
    else if (sc.mode === 'vehicle') ws.setScope(sc);
  }
  if (s.camera) setTimeout(() => getViewport()?.setCameraState(s.camera!), 50);
}

/** Watches what makes up a session and saves it shortly after changes. */
export function useSessionAutosave() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => saveSession().catch(() => {}), 1500);
    };
    const a = useSel.subscribe((st, prev) => st.scope !== prev.scope && later());
    const b = useUi.subscribe((st, prev) => (st.tabs !== prev.tabs || st.activeTab !== prev.activeTab) && later());
    const c = useWs.subscribe((st, prev) => {
      if (st.model && st.model !== prev.model) addRecentVehicle(st.model);
    });
    const onCam = () => later();
    const vp = getViewport();
    vp?.controls.addEventListener('end', onCam);
    window.addEventListener('beforeunload', () => saveSession());
    return () => {
      a();
      b();
      c();
      vp?.controls.removeEventListener('end', onCam);
    };
  }, []);
}

export function StartPage() {
  const recent = useRecent();
  const vehicles = useWs((x) => x.vehicles);
  const open = (m: string) => ws.openVehicle(m);
  return (
    <div className="start">
      <div className="start-head">
        <div className="start-title">EditorNG</div>
        <div className="dim">JBeam editor for BeamNG.drive</div>
      </div>
      <div className="start-actions">
        <button className="btn primary" onClick={() => command('app.openVehicle')}><Car size={14} /> Open vehicle…</button>
        <button className="btn" onClick={() => command('file.openFile')}><FolderOpen size={14} /> Open .jbeam file…</button>
        <button className="btn" onClick={() => useUi.setState({ dialog: { kind: 'newVehicle' } })}><FilePlus2 size={14} /> New vehicle…</button>
      </div>
      <div className="start-cols">
        <div>
          <div className="group-label">Recent vehicles</div>
          {recent.vehicles.map((m) => {
            const info = vehicles.find((v) => v.model.toLowerCase() === m.toLowerCase());
            return (
              <button key={m} className="start-item" onClick={() => open(m)}>
                <Car size={14} className={info && info.sources[0]?.kind !== 'game' ? 'accent-text' : 'faint'} />
                <span className="mono">{m}</span>
                <span className="faint small-text ellipsis">{info?.sources[0]?.label ?? ''}</span>
              </button>
            );
          })}
          {!recent.vehicles.length && <div className="faint start-empty">Vehicles you open show up here.</div>}
        </div>
        <div>
          <div className="group-label">Recent files</div>
          {recent.files.map((f) => (
            <button key={f} className="start-item" onClick={() => ws.openFiles([f])} title={f}>
              <FileCode2 size={14} className="icon-jbeam" />
              <span className="mono">{f.split(/[\\/]/).pop()}</span>
              <span className="faint small-text ellipsis">{f.split(/[\\/]/).slice(-3, -1).join('/')}</span>
            </button>
          ))}
          {!recent.files.length && <div className="faint start-empty">Loose .jbeam files you open show up here.</div>}
        </div>
      </div>
      <div className="start-foot faint">
        <button className="rl-btn" onClick={() => command('help.shortcuts')}>Keyboard shortcuts (F1)</button> ·{' '}
        <button className="rl-btn" onClick={() => useUi.setState({ dialog: { kind: 'gameLink' } })}><Link2 size={11} /> Set up Reload in game</button> ·{' '}
        <button className="rl-btn" onClick={() => useUi.setState({ dialog: { kind: 'packMod' } })}><Package size={11} /> Pack a mod</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// compare with backup / original (5.10)
// ------------------------------------------------------------------------------------------

export function DiffDialog({ close, data }: { close: () => void; data: { doc: string; against: 'backup' | 'original' } }) {
  const host = useRef<HTMLDivElement>(null);
  const d = ws.doc(data.doc);
  const [sources, setSources] = useState<Array<{ label: string; load: () => Promise<string> }>>([]);
  const [pick, setPick] = useState(0);
  const [msg, setMsg] = useState('Looking…');
  useEffect(() => {
    if (!d) return;
    (async () => {
      const list: Array<{ label: string; load: () => Promise<string> }> = [];
      if (data.against === 'backup' && d.ref.real) {
        for (const b of await api.listBackups(d.ref.real, settings().backupDir || undefined)) {
          list.push({ label: new Date(b.time).toLocaleString(), load: () => api.readTextFile(b.path) });
        }
      } else {
        const all = await api.findAllFiles(d.vpath);
        for (const f of all) {
          if (f.real && d.ref.real && f.real.toLowerCase() === d.ref.real.toLowerCase()) continue;
          list.push({ label: f.source, load: async () => (await api.readTexts([f]))[0] });
        }
      }
      setSources(list);
      setMsg(list.length ? '' : data.against === 'backup' ? 'No backups yet: one is written each time you save (Settings → Editing).' : 'No other version of this file: it is not a copy of a game or mod file.');
    })();
  }, []);
  useEffect(() => {
    if (!host.current || !d || !sources[pick]) return;
    let disposed = false;
    const ed = monaco.editor.createDiffEditor(host.current, { readOnly: false, originalEditable: false, automaticLayout: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: settings().editorFontSize });
    const model = ws.ensureModel(d);
    let orig: monaco.editor.ITextModel | null = null;
    sources[pick].load().then((text) => {
      if (disposed) return;
      orig = monaco.editor.createModel(text, model.getLanguageId());
      ed.setModel({ original: orig, modified: model });
    });
    return () => {
      disposed = true;
      ed.setModel(null);
      ed.dispose();
      orig?.dispose();
    };
  }, [sources, pick]);
  if (!d) return null;
  return (
    <Modal title={`${d.name}: compare with ${data.against === 'backup' ? 'backup' : 'original'}`} onClose={close} width={Math.min(1400, window.innerWidth - 80)} footer={<>
      {sources.length > 1 && (
        <select className="select small" value={pick} onChange={(e) => setPick(+e.target.value)} style={{ marginRight: 'auto' }}>
          {sources.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
        </select>
      )}
      <span className="faint small-text" style={{ marginRight: 'auto' }}>Left: {sources[pick]?.label ?? '—'} · right: your file (editable)</span>
      <button className="btn primary" onClick={close}>Done</button>
    </>}>
      {msg ? <div className="empty-hint">{msg}</div> : <div ref={host} className="diff-host" />}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------
// pack a mod with a pre-release check (5.12)
// ------------------------------------------------------------------------------------------

type Scan = Awaited<ReturnType<typeof api.scanMod>>;

export function PackModDialog({ close }: { close: () => void }) {
  const [dir, setDir] = useState<string>(() => guessModDir() ?? '');
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (d = dir) => {
    if (!d) return;
    setBusy(true);
    try {
      setScan(await api.scanMod(d));
    } catch (e: any) {
      toast('error', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (dir) run(dir);
  }, []);
  const errors = scan?.issues.filter((i) => i.sev === 'error').length ?? 0;
  const icon = { error: <AlertCircle size={13} className="err-text" />, warning: <AlertTriangle size={13} className="warn-text" />, info: <Info size={13} className="info-text" /> };
  return (
    <Modal title="Pack mod" onClose={close} width={720} footer={<>
      <button className="btn" onClick={close}>Close</button>
      <button className="btn primary" disabled={!scan || busy} onClick={async () => {
        if (!scan) return;
        if (useWs.getState().dirtyCount > 0) await ws.saveAll();
        const out = await api.saveDialog({ title: 'Save mod zip', defaultPath: dir.replace(/[\\/]mods[\\/]unpacked[\\/][^\\/]+$/i, '') + '\\' + scan.name + '.zip', filters: [{ name: 'Zip', extensions: ['zip'] }] });
        if (!out) return;
        setBusy(true);
        try {
          const r = await api.packMod(dir, out);
          toast('ok', `Packed ${r.files} files (${(r.size / 1048576).toFixed(1)} MB) → ${out.split(/[\\/]/).pop()}`);
          api.reveal(out);
        } finally {
          setBusy(false);
        }
      }}><Package size={13} /> {errors ? `Pack anyway (${errors} errors)` : 'Pack zip…'}</button>
    </>}>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <input className="input grow mono" value={dir} placeholder="mods/unpacked/<your mod>" onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') run(); }} />
        <button className="btn" onClick={async () => {
          const p = await api.pickFolder('Mod folder (mods/unpacked/<mod>)', dir || settings().userDir || undefined);
          if (p) {
            setDir(p);
            run(p);
          }
        }}><FolderOpen size={13} /> Browse</button>
        <button className="btn" disabled={!dir || busy} onClick={() => run()}>Check</button>
      </div>
      {busy && <div className="faint">Checking… (the first run indexes the game's part names)</div>}
      {scan && !busy && (
        <>
          <div className="dim" style={{ marginBottom: 6 }}>
            <b className="mono">{scan.name}</b> · {scan.files.length} files · {(scan.total / 1048576).toFixed(1)} MB ·{' '}
            {scan.issues.length ? `${errors} errors, ${scan.issues.length - errors} notes` : 'nothing to fix, ready to pack'}
          </div>
          <div className="list-scroll pack-list">
            {scan.issues.map((i, k) => (
              <div key={k} className="problem" onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [{ label: 'Copy', run: () => navigator.clipboard.writeText(`${i.file ?? ''} ${i.msg}`) }]);
              }}>
                {icon[i.sev]}
                <span className="grow">{i.msg}</span>
                {i.file && <span className="faint mono small-text ellipsis" style={{ maxWidth: 300 }}>{i.file}</span>}
              </div>
            ))}
          </div>
          <div className="faint small-text" style={{ marginTop: 8 }}>Rules from the game's NOTE_FOR_MODDERS.md: unique names, no overridden game files, no leftover files, texture naming, info file and preview.</div>
        </>
      )}
    </Modal>
  );
}

/** mods/unpacked/<mod> of the open vehicle, when it lives there */
function guessModDir(): string | null {
  for (const d of ws.docs.values()) {
    const r = d.ref.real;
    if (!r || d.isCommon) continue;
    const m = /^(.*[\\/]mods[\\/]unpacked[\\/][^\\/]+)[\\/]/i.exec(r);
    if (m) return m[1];
  }
  return null;
}
