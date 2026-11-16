import { useEffect, useMemo, useState } from 'react';
import {
  Search, Package, FolderOpen, FilePlus2, ChevronRight, ChevronDown, Lock, File as FileIcon, Car, Puzzle,
  Target, CircleSlash, Save,
} from 'lucide-react';
import { ws, useWs, type Doc } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { useSel, emptySel, addToSel, setSel } from '../state/selection';
import type { ANode } from '@core/sjson';
import { revealRange } from '../editor/CodeEditor';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { settings } from '../state/settings';
import type { SlotNode, ActivePart } from '@core/jbeam/types';
import { command } from './commands';
import { fileIconFor, folderIcon } from './fileIcons';
import { openMenu } from './Menu';
import { swapSideTokens } from '@core/jbeam/mirror';

export function PanelHeader(props: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-header">
      <span className="panel-title">{props.title}</span>
      <div className="row" style={{ gap: 2 }}>{props.children}</div>
    </div>
  );
}

function SearchBox(props: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <Search size={13} className="faint" />
      <input className="input small" value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Explorer
// ------------------------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  doc?: Doc;
}

function FilesTree(props: { q: string; showCommon: boolean; jbeamOnly: boolean }) {
  const { q, showCommon, jbeamOnly } = props;
  const docs = useWs((x) => x.docs);
  const model = useWs((x) => x.model);
  const activeTab = useUi((x) => x.activeTab);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openParts, setOpenParts] = useState<Set<string>>(new Set());
  const vehicle = useWs((x) => x.vehicle);
  const scope = useSel((x) => x.scope);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  // the file being viewed is always expanded
  const scopeFile = scope.mode === 'vehicle' ? null : scope.file;
  const isOpen = (k: string) => openFiles.has(k) || k === scopeFile || !!q;
  const toggleFile = (k: string) => {
    const n = new Set(openFiles);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setOpenFiles(n);
  };

  const activeCommon = useMemo(() => {
    const s = new Set<string>();
    for (const p of vehicle?.parts ?? []) s.add(p.def.file);
    return s;
  }, [vehicle]);

  const tree = useMemo(() => {
    const root: TreeNode = { name: '', path: '', children: new Map() };
    for (const d of docs) {
      if (d.isCommon && !(showCommon && activeCommon.has(d.key))) continue;
      if (jbeamOnly && d.lang !== 'jbeam') continue;
      if (q && !d.vpath.toLowerCase().includes(q.toLowerCase()) && !(d.jfile?.parts.some((p) => p.name.toLowerCase().includes(q.toLowerCase())))) continue;
      let rel = d.vpath;
      if (model && rel.toLowerCase().startsWith(`vehicles/${model.toLowerCase()}/`)) rel = rel.slice(`vehicles/${model}/`.length);
      const parts = rel.split('/');
      let cur = root;
      parts.forEach((p, i) => {
        const key = parts.slice(0, i + 1).join('/');
        let c = cur.children.get(p);
        if (!c) cur.children.set(p, (c = { name: p, path: key, children: new Map() }));
        if (i === parts.length - 1) c.doc = d;
        cur = c;
      });
    }
    return root;
  }, [docs, q, model, showCommon, activeCommon, jbeamOnly]);

  const render = (n: TreeNode, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const entries = [...n.children.values()].sort((a, b) => Number(!!a.doc) - Number(!!b.doc) || a.name.localeCompare(b.name));
    for (const c of entries) {
      if (c.doc) {
        const d = c.doc;
        const dirty = ws.isDirty(d);
        const parts = d.jfile?.parts ?? [];
        const hasParts = d.lang === 'jbeam' && parts.length > 0;
        const open = hasParts && isOpen(d.key);
        const viewing = scope.mode === 'file' && scope.file === d.key;
        out.push(
          <div
            key={c.path}
            className={'tree-item file' + (activeTab === d.key ? ' active' : '') + (viewing ? ' viewing' : '')}
            style={{ paddingLeft: 4 + depth * 12 }}
            onContextMenu={(e) => {
              e.preventDefault();
              fileMenu(e.clientX, e.clientY, d);
            }}
            title={`${d.vpath}\n${d.source}${d.writable ? '' : ' — read-only'}`}
          >
            {hasParts ? (
              <button className="icon-btn small tiny" onClick={() => toggleFile(d.key)} aria-label={open ? 'Collapse' : 'Expand'}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
            ) : <span style={{ width: 18, flex: 'none' }} />}
            <button className="tree-label" onClick={() => {
              openTab(d.key);
              if (hasParts && vehicle?.parts.some((ap) => ap.def.file === d.key)) ws.setScope({ mode: 'file', file: d.key });
            }}>
              {fileIconFor(d.name)}
              <span className="ellipsis grow">{c.name}</span>
            </button>
            {!d.writable && <Lock size={11} className="faint" />}
            {dirty && <span className="dirty-dot" />}
          </div>,
        );
        if (open) {
          for (const part of parts) {
            const active = !!vehicle?.partsByName.get(part.name);
            const viewingPart = scope.mode === 'part' && scope.part === part.name;
            const pk = d.key + '#' + part.name;
            const partOpen = openParts.has(pk);
            out.push(
              <div
                key={pk}
                className={'tree-item part' + (viewingPart ? ' viewing' : '') + (active ? '' : ' inactive')}
                style={{ paddingLeft: 12 + depth * 12 }}
                title={`${part.name}\nslotType: ${part.slotTypes.join(', ')}${active ? '' : '\nnot used by the current configuration — click to show it'}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  partMenuHandler(e.clientX, e.clientY, part.name, d.key);
                }}
              >
                <button className="icon-btn small tiny" onClick={() => {
                  const n = new Set(openParts);
                  if (n.has(pk)) n.delete(pk);
                  else n.add(pk);
                  setOpenParts(n);
                }} aria-label={partOpen ? 'Collapse' : 'Expand'}>{partOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
                <button className="tree-label" onClick={() => {
                  ws.focusPart(part.name);
                  revealRange(d.key, part.key.s, part.key.e);
                }}>
                  <Puzzle size={12} className={active ? 'part-icon' : 'faint'} />
                  <span className="mono ellipsis grow">{part.name}</span>
                  {part.info.name && <span className="faint ellipsis small-text" style={{ maxWidth: '45%' }}>{part.info.name}</span>}
                </button>
              </div>,
            );
            if (partOpen) {
              for (const [sec, node] of part.sections) {
                const cnt = sectionCount(node);
                const geo = SELECTABLE.has(sec);
                out.push(
                  <button
                    key={pk + '/' + sec}
                    className={'tree-item section' + (geo ? '' : ' muted')}
                    style={{ paddingLeft: 44 + depth * 12 }}
                    onClick={() => {
                      const k = part.sectionKeys.get(sec);
                      if (k) revealRange(d.key, k.s, node.e);
                      if (geo && active) selectSection(part.name, sec);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const k = part.sectionKeys.get(sec);
                      openMenu(e.clientX, e.clientY, [
                        { title: `${part.name} › ${sec}` },
                        { label: 'Select all', disabled: geo && active ? false : !active ? 'Part not in the current configuration' : 'Nothing to select in 3D', run: () => selectSection(part.name, sec) },
                        { label: 'Go to section', run: () => k && revealRange(d.key, k.s, k.e, true) },
                      ]);
                    }}
                    title={geo ? `Select all ${sec} of ${part.name}` : sec}
                  >
                    <span className="mono ellipsis grow">{sec}</span>
                    {cnt !== null && <span className="tree-count">{cnt}</span>}
                  </button>,
                );
              }
            }
          }
        }
      } else {
        const isCol = collapsed.has(c.path) && !q;
        out.push(
          <button key={c.path} className="tree-item folder" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => {
            const s = new Set(collapsed);
            if (s.has(c.path)) s.delete(c.path);
            else s.add(c.path);
            setCollapsed(s);
          }}>
            {isCol ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            {folderIcon(!isCol)}
            <span className="ellipsis">{c.name}</span>
          </button>,
        );
        if (!isCol) out.push(...render(c, depth + 1));
      }
    }
    return out;
  };

  return (
    <div className="panel-scroll">
      {render(tree, 0)}
      {!docs.length && <div className="empty-hint">Open a vehicle to see its files.</div>}
    </div>
  );
}

const SELECTABLE = new Set(['nodes', 'beams', 'triangles', 'quads', 'flexbodies', 'props', 'triggers', 'triggers2', 'slidenodes', 'pressureWheels', 'hubWheels']);

/** Rows in a table section (header and modifier objects excluded) or keys of an object section. */
function sectionCount(n: ANode): number | null {
  if (n.k === 'arr') {
    let c = 0;
    n.items.forEach((it, i) => {
      if (it.k !== 'arr') return;
      if (i === 0 && it.items.every((x) => x.k === 'str')) return;
      c++;
    });
    return c;
  }
  if (n.k === 'obj') return n.keys.length;
  return null;
}

/** Selects every element produced by one section of a part. */
export function selectSection(part: string, section: string) {
  const v = ws.vehicle;
  if (!v) return;
  const s = emptySel();
  const of = (r: { part: { def: { name: string } }; src: { section: string } }) => r.part.def.name === part && r.src.section === section;
  v.nodes.forEach((n, i) => of(n.row) && addToSel(v, s, 'node', i));
  v.beams.forEach((b, i) => of(b.row) && addToSel(v, s, 'beam', i));
  v.tris.forEach((t, i) => of(t.row) && addToSel(v, s, 'tri', i));
  v.flexbodies.forEach((f, i) => of(f.row) && addToSel(v, s, 'flex', i));
  v.props.forEach((pr, i) => of(pr.row) && addToSel(v, s, 'prop', i));
  v.triggers.forEach((r, i) => of(r) && addToSel(v, s, 'trigger', i));
  v.wheels.forEach((w, i) => of(w.row) && addToSel(v, s, 'wheel', i));
  if (section === 'slidenodes') for (const r of v.tables.get('slidenodes') ?? []) if (of(r) && typeof r.v['id:'] === 'string') s.nodes.add(r.v['id:']);
  setSel(s);
}

/** Right-click on a part in either tree; installed by the shared context menu. */
let partMenuHandler: (x: number, y: number, part: string, file: string) => void = (x, y, part, file) => {
  const v = ws.vehicle;
  const ap = v?.partsByName.get(part);
  const d = ws.doc(file);
  const def = ap?.def ?? d?.jfile?.parts.find((p) => p.name === part);
  const writable = !!d?.writable && !d.isCommon;
  const mirrorName = swapSideTokens(part);
  const canMirror = mirrorName !== part && !ws.partDef(mirrorName);
  openMenu(x, y, [
    { title: part },
    { label: 'Show only this part', key: 'Shift+I', run: () => ws.focusPart(part) },
    { label: 'Show its file', run: () => ws.setScope({ mode: 'file', file }) },
    { label: 'Go to definition', run: () => def && revealRange(file, def.key.s, def.key.e, true) },
    'sep',
    { label: 'Write new elements here', checked: useWs.getState().target?.part === part, disabled: writable ? false : 'Read-only file: make an editable copy first', run: () => ws.setTarget(file, part) },
    { label: `Mirror to ${mirrorName}…`, disabled: canMirror ? false : mirrorName === part ? 'No _L/_R (or l/r) side token in the name' : `${mirrorName} already exists`, run: () => useUi.setState({ dialog: { kind: 'mirrorPart', data: part } }) },
    'sep',
    { label: 'Copy name', run: () => navigator.clipboard.writeText(part) },
  ]);
};
export function setPartMenuHandler(fn: typeof partMenuHandler) {
  partMenuHandler = fn;
}

// ------------------------------------------------------------------------------------------
// Structure panel: files → parts → sections, or the slot tree
// ------------------------------------------------------------------------------------------

export function StructurePanel() {
  const model = useWs((x) => x.model);
  const mode = useUi((x) => x.structMode);
  const [q, setQ] = useState('');
  const [showCommon, setShowCommon] = useState(false);
  const [jbeamOnly, setJbeamOnly] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  return (
    <div className="panel">
      <PanelHeader title={model ?? 'Structure'}>
        <button className="icon-btn small" data-tip="Open vehicle…" onClick={() => command('app.openVehicle')} aria-label="Open vehicle"><Car size={14} /></button>
        <button className="icon-btn small" data-tip="Open .jbeam file(s)" onClick={() => command('file.openFile')} aria-label="Open file"><FolderOpen size={14} /></button>
        <button className="icon-btn small" data-tip="New mod" data-tip-pos="bottom-left" onClick={() => useUi.setState({ dialog: { kind: 'newMod' } })} aria-label="New mod"><FilePlus2 size={14} /></button>
      </PanelHeader>
      <div className="row struct-switch">
        <div className="segmented small grow">
          <button className={'seg grow' + (mode === 'files' ? ' active' : '')} onClick={() => useUi.setState({ structMode: 'files' })}>Files</button>
          <button className={'seg grow' + (mode === 'slots' ? ' active' : '')} onClick={() => useUi.setState({ structMode: 'slots' })}>Slots</button>
        </div>
        {mode === 'files' ? (
          <>
            <button className={'icon-btn small' + (!jbeamOnly ? ' active' : '')} data-tip={jbeamOnly ? 'Showing .jbeam only: show all files' : 'Show .jbeam files only'} data-tip-pos="bottom-left" onClick={() => setJbeamOnly(!jbeamOnly)} aria-label="All files"><FileIcon size={13} /></button>
            <button className={'icon-btn small' + (showCommon ? ' active' : '')} data-tip="Show active common/ files" data-tip-pos="bottom-left" onClick={() => setShowCommon(!showCommon)} aria-label="Show common"><Package size={13} /></button>
          </>
        ) : (
          <>
            <button className={'icon-btn small' + (showEmpty ? ' active' : '')} data-tip="Show empty slots" data-tip-pos="bottom-left" onClick={() => setShowEmpty(!showEmpty)} aria-label="Show empty slots"><CircleSlash size={13} /></button>
            <button className="icon-btn small" data-tip="Save configuration as .pc" data-tip-pos="bottom-left" onClick={() => command('config.save')} aria-label="Save config"><Save size={13} /></button>
          </>
        )}
      </div>
      <SearchBox value={q} onChange={setQ} placeholder={mode === 'files' ? 'Filter files & parts' : 'Filter parts / slots'} />
      {mode === 'files' ? <FilesTree q={q} showCommon={showCommon} jbeamOnly={jbeamOnly} /> : <SlotTree q={q} showEmpty={showEmpty} />}
    </div>
  );
}

/** Right-click on a file in the tree. */
export function fileMenu(x: number, y: number, d: Doc) {
  const v = ws.vehicle;
  const inVehicle = !!v?.parts.some((p) => p.def.file === d.key);
  openMenu(x, y, [
    { title: d.name },
    { label: 'Open', run: () => openTab(d.key) },
    { label: 'Show this file in 3D', disabled: inVehicle ? false : 'No active part in this file', run: () => ws.setScope({ mode: 'file', file: d.key }) },
    { label: 'Save', key: 'Ctrl+S', disabled: d.writable && ws.isDirty(d) ? false : 'No unsaved changes', run: () => ws.save(d.key) },
    !d.writable && { label: 'Make editable copy…', run: () => useUi.setState({ dialog: { kind: 'makeEditable', data: d.key } }) },
    { label: 'Compare with backup…', disabled: d.writable && d.ref.real ? false : 'Only for editable files on disk', run: () => useUi.setState({ dialog: { kind: 'diff', data: { doc: d.key, against: 'backup' } } }) },
    { label: 'Compare with original…', hint: 'game / other mod', disabled: d.writable ? false : 'This is the original', run: () => useUi.setState({ dialog: { kind: 'diff', data: { doc: d.key, against: 'original' } } }) },
    'sep',
    { label: 'Reveal in Explorer', disabled: d.ref.real ? false : 'Inside a zip', run: () => d.ref.real && api.reveal(d.ref.real) },
    { label: 'Copy path', run: () => navigator.clipboard.writeText(d.ref.real ?? d.vpath) },
  ]);
}


// ------------------------------------------------------------------------------------------
// Parts / slot tree
// ------------------------------------------------------------------------------------------

function SlotTree(props: { q: string; showEmpty: boolean }) {
  const { q, showEmpty } = props;
  const v = useWs((x) => x.vehicle);
  const configs = useWs((x) => x.configs);
  const active = useWs((x) => x.activeConfig);
  const mode = useWs((x) => x.mode);
  const target = useWs((x) => x.target);
  const scope = useSel((x) => x.scope);
  const focusPart = scope.mode === 'part' ? scope.part : null;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (!v) return <div className="empty-hint">Open a vehicle first.</div>;

  const toggle = (k: string) => {
    const s = new Set(collapsed);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    setCollapsed(s);
  };

  const matchesQ = (p: ActivePart | undefined, sn?: SlotNode): boolean => {
    if (!q) return true;
    const l = q.toLowerCase();
    if (sn && (sn.id.toLowerCase().includes(l) || sn.def.description.toLowerCase().includes(l))) return true;
    if (!p) return false;
    if (p.def.name.toLowerCase().includes(l) || (p.def.info.name ?? '').toLowerCase().includes(l)) return true;
    return p.slots.some((c) => matchesQ(c.part, c));
  };

  const partRow = (p: ActivePart, depth: number, sn?: SlotNode) => {
    const doc = ws.doc(p.def.file);
    const isTarget = target?.part === p.def.name;
    return (
      <div className={'part-row' + (isTarget ? ' target' : '') + (focusPart === p.def.name ? ' viewing' : '')} style={{ paddingLeft: 8 + depth * 12 }}
        onContextMenu={(e) => {
          e.preventDefault();
          partMenuHandler(e.clientX, e.clientY, p.def.name, p.def.file);
        }}>
        {p.slots.length ? (
          <button className="icon-btn small tiny" onClick={() => toggle(p.path)} aria-label="Toggle">{collapsed.has(p.path) && !q ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
        ) : <span style={{ width: 18 }} />}
        <button className="part-name" onClick={() => {
          revealRange(p.def.file, p.def.key.s, p.def.key.e);
          ws.focusPart(p.def.name);
        }} title={`${p.def.name}\n${p.def.file}`}>
          {sn ? <span className="slot-label">{sn.def.description || sn.id}</span> : null}
          <span className={'mono ellipsis' + (doc?.isCommon ? ' faint' : '')}>{p.def.name}</span>
        </button>
        {!doc?.writable && <Lock size={10} className="faint" />}
        {isTarget && <span data-tip="Target part: new elements go here" data-tip-pos="left"><Target size={11} className="faint" /></span>}
      </div>
    );
  };

  const slotRows = (owner: ActivePart, depth: number): React.ReactNode[] => {
    if (collapsed.has(owner.path) && !q) return [];
    const out: React.ReactNode[] = [];
    for (const sn of owner.slots) {
      if (!matchesQ(sn.part, sn)) continue;
      if (sn.part) {
        out.push(
          <div key={sn.path} className="slot-block">
            {partRow(sn.part, depth, sn)}
            <SlotSelect sn={sn} depth={depth} />
            {slotRows(sn.part, depth + 1)}
          </div>,
        );
      } else if (showEmpty || q) {
        out.push(
          <div key={sn.path} className="slot-block empty" style={{ paddingLeft: 26 + depth * 12 }}>
            <span className="slot-label">{sn.def.description || sn.id}</span>
            <SlotSelect sn={sn} depth={-1} />
          </div>,
        );
      }
    }
    return out;
  };

  return (
    <>
      {mode === 'vehicle' && (
        <div className="panel-pad">
          <select className="select small" style={{ width: '100%' }} value={active} onChange={(e) => ws.setActiveConfig(e.target.value)}>
            <option value="">Default parts (no config)</option>
            {configs.map((c) => (
              <option key={c.key} value={c.key}>{c.name.replace(/\.pc$/i, '')}</option>
            ))}
          </select>
        </div>
      )}
      <div className="panel-scroll">
        {v.root && mode === 'vehicle' ? (
          <>
            {partRow(v.root, 0)}
            {slotRows(v.root, 1)}
          </>
        ) : (
          v.parts.map((p) => <div key={p.path}>{partRow(p, 0)}</div>)
        )}
      </div>
    </>
  );
}

function SlotSelect({ sn, depth }: { sn: SlotNode; depth: number }) {
  const lib = ws.lib;
  if (!lib) return null;
  const options = lib.compatible(sn.def);
  if (options.length <= 1 && sn.chosen && sn.def.coreSlot) return null;
  return (
    <div className="slot-select" style={{ paddingLeft: depth >= 0 ? 26 + depth * 12 : 0 }}>
      <select
        className="select small"
        value={sn.chosen}
        onChange={(e) => ws.setSlotPart(sn.id, e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        title={`slot ${sn.id} (${sn.def.allowTypes.join(', ')})`}
      >
        {!sn.def.coreSlot && <option value="">— empty —</option>}
        {options.map((p) => (
          <option key={p.name} value={p.name}>{p.info.name ? `${p.info.name}` : p.name}</option>
        ))}
      </select>
    </div>
  );
}

export function useOpenFiles() {
  return async () => {
    const p = await api.pickFile({ title: 'Open JBeam file', filters: [{ name: 'JBeam', extensions: ['jbeam'] }, { name: 'All files', extensions: ['*'] }], defaultPath: settings().userDir || undefined });
    if (p) ws.openFiles([p]);
    else toast('info', 'Nothing opened');
  };
}
