import { useEffect, useMemo, useState } from 'react';
import {
  Search, RefreshCw, Package, FolderOpen, FilePlus2, ChevronRight, ChevronDown, Lock, FileCode2, FileJson, File as FileIcon, Car, Puzzle, Eye, Crosshair,
  Target, CircleSlash,
} from 'lucide-react';
import { ws, useWs, type Doc } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { useSel } from '../state/selection';
import { revealRange } from '../editor/CodeEditor';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { settings } from '../state/settings';
import type { SlotNode, ActivePart } from '@core/jbeam/types';
import { command } from './commands';

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
// Vehicles
// ------------------------------------------------------------------------------------------

export function VehiclesPanel() {
  const vehicles = useWs((x) => x.vehicles);
  const current = useWs((x) => x.model);
  const loading = useWs((x) => x.loading);
  const [q, setQ] = useState('');
  const [showGame, setShowGame] = useState(false);
  useEffect(() => {
    if (!vehicles.length) ws.refreshVehicleList();
  }, []);
  const filtered = vehicles.filter((v) => !q || v.model.toLowerCase().includes(q.toLowerCase()) || v.sources.some((s) => s.label.toLowerCase().includes(q.toLowerCase())));
  const mods = filtered.filter((v) => v.sources.some((s) => s.kind !== 'game'));
  const game = filtered.filter((v) => !v.sources.some((s) => s.kind !== 'game'));
  const item = (v: (typeof vehicles)[0]) => {
    const src = v.sources[0];
    return (
      <button key={v.model} className={'list-item' + (current === v.model ? ' active' : '')} onClick={() => ws.openVehicle(v.model)} disabled={!!loading} title={v.sources.map((s) => s.label).join('\n')}>
        <Car size={14} className={src.kind === 'game' ? 'faint' : 'accent-text'} />
        <span className="ellipsis grow">{v.model}</span>
        <span className="faint ellipsis small-text" style={{ maxWidth: 110 }}>{src.kind === 'game' ? '' : src.label}</span>
      </button>
    );
  };
  return (
    <div className="panel">
      <PanelHeader title="Vehicles">
        <button className="icon-btn small" data-tip="New vehicle" onClick={() => useUi.setState({ dialog: { kind: 'newVehicle' } })} aria-label="New vehicle"><FilePlus2 size={14} /></button>
        <button className="icon-btn small" data-tip="Open .jbeam file(s)" onClick={() => command('file.openFile')} aria-label="Open file"><FolderOpen size={14} /></button>
        <button className="icon-btn small" data-tip="Rescan mods" data-tip-pos="bottom-left" onClick={() => ws.refreshVehicleList()} aria-label="Rescan"><RefreshCw size={14} /></button>
      </PanelHeader>
      <SearchBox value={q} onChange={setQ} placeholder="Filter vehicles" />
      <div className="panel-scroll">
        <div className="group-label">Mods &amp; user folder <span className="badge">{mods.length}</span></div>
        {mods.map(item)}
        {!mods.length && <div className="empty-hint">No modded vehicles found in mods/unpacked or the user folder.</div>}
        <button className="group-label clickable" onClick={() => setShowGame(!showGame)}>
          {showGame || q ? <ChevronDown size={12} /> : <ChevronRight size={12} />} BeamNG vehicles <span className="badge">{game.length}</span>
        </button>
        {(showGame || q) && game.map(item)}
      </div>
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

function fileIcon(d: Doc) {
  if (d.lang === 'jbeam') return <FileCode2 size={14} className="icon-jbeam" />;
  if (d.lang === 'json') return <FileJson size={14} className="icon-json" />;
  return <FileIcon size={14} className="faint" />;
}

export function ExplorerPanel() {
  const docs = useWs((x) => x.docs);
  const model = useWs((x) => x.model);
  const activeTab = useUi((x) => x.activeTab);
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<null | { x: number; y: number; doc: Doc }>(null);
  const [showCommon, setShowCommon] = useState(false);
  const [jbeamOnly, setJbeamOnly] = useState(true);
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
        const textual = d.lang !== 'text' || /\.(txt|md|ini)$/i.test(d.name);
        const parts = d.jfile?.parts ?? [];
        const hasParts = d.lang === 'jbeam' && parts.length > 0;
        const open = hasParts && isOpen(d.key);
        const viewing = scope.mode === 'file' && scope.file === d.key;
        out.push(
          <div
            key={c.path}
            className={'tree-item file' + (activeTab === d.key ? ' active' : '') + (viewing ? ' viewing' : '') + (textual ? '' : ' muted')}
            style={{ paddingLeft: 4 + depth * 12 }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, doc: d });
            }}
            title={`${d.vpath}\n${d.source}${d.writable ? '' : ' — read-only'}`}
          >
            {hasParts ? (
              <button className="icon-btn small tiny" onClick={() => toggleFile(d.key)} aria-label={open ? 'Collapse' : 'Expand'}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
            ) : <span style={{ width: 18, flex: 'none' }} />}
            <button className="tree-label" onClick={() => {
              if (!textual) return;
              openTab(d.key);
              if (hasParts && vehicle?.parts.some((ap) => ap.def.file === d.key)) ws.setScope({ mode: 'file', file: d.key });
            }}>
              {fileIcon(d)}
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
            out.push(
              <button
                key={c.path + '#' + part.name}
                className={'tree-item part' + (viewingPart ? ' viewing' : '') + (active ? '' : ' inactive')}
                style={{ paddingLeft: 26 + depth * 12 }}
                onClick={() => {
                  if (ws.focusPart(part.name)) revealRange(d.key, part.key.s, part.key.e);
                  else revealRange(d.key, part.key.s, part.key.e);
                }}
                title={`${part.name}\nslotType: ${part.slotTypes.join(', ')}${active ? '' : '\nnot used by the current configuration — click to show it'}`}
              >
                <Puzzle size={12} className={active ? 'accent-text' : 'faint'} />
                <span className="mono ellipsis grow">{part.name}</span>
                {part.info.name && <span className="faint ellipsis small-text" style={{ maxWidth: '45%' }}>{part.info.name}</span>}
              </button>,
            );
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
            <span className="ellipsis">{c.name}</span>
          </button>,
        );
        if (!isCol) out.push(...render(c, depth + 1));
      }
    }
    return out;
  };

  return (
    <div className="panel" onClick={() => setMenu(null)}>
      <PanelHeader title={model ? `Files — ${model}` : 'Files'}>
        <button className={'icon-btn small' + (showCommon ? ' active' : '')} data-tip="Show active common/ files" data-tip-pos="bottom-left" onClick={() => setShowCommon(!showCommon)} aria-label="Show common"><Package size={14} /></button>
      </PanelHeader>
      <div className="row" style={{ margin: '0 8px 6px', gap: 6 }}>
        <div className="search-box grow" style={{ margin: 0 }}>
          <Search size={13} className="faint" />
          <input className="input small" value={q} placeholder="Filter files & parts" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="segmented small">
          <button className={'seg' + (jbeamOnly ? ' active' : '')} onClick={() => setJbeamOnly(true)}>JBeam</button>
          <button className={'seg' + (!jbeamOnly ? ' active' : '')} onClick={() => setJbeamOnly(false)}>All</button>
        </div>
      </div>
      <div className="panel-scroll">
        {render(tree, 0)}
        {!docs.length && <div className="empty-hint">Open a vehicle to see its files.</div>}
      </div>
      {menu && <FileMenu x={menu.x} y={menu.y} doc={menu.doc} close={() => setMenu(null)} />}
    </div>
  );
}

function FileMenu(props: { x: number; y: number; doc: Doc; close: () => void }) {
  const d = props.doc;
  const act = async (fn: () => Promise<void> | void) => {
    props.close();
    await fn();
  };
  return (
    <div className="ctx-menu fixed" style={{ left: props.x, top: props.y }} onClick={(e) => e.stopPropagation()}>
      <button className="ctx-item" onClick={() => act(() => openTab(d.key))}>Open</button>
      {d.ref.real && <button className="ctx-item" onClick={() => act(() => api.reveal(d.ref.real!))}>Reveal in Explorer</button>}
      {!d.writable && (
        <button className="ctx-item" onClick={() => act(() => useUi.setState({ dialog: { kind: 'makeEditable', data: d.key } }))}>Make editable copy…</button>
      )}
      {d.writable && ws.isDirty(d) && <button className="ctx-item" onClick={() => act(() => ws.save(d.key).then(() => undefined))}>Save</button>}
      <button className="ctx-item" onClick={() => act(() => navigator.clipboard.writeText(d.vpath))}>Copy path</button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------
// Parts / slot tree
// ------------------------------------------------------------------------------------------

export function PartsPanel() {
  const v = useWs((x) => x.vehicle);
  const configs = useWs((x) => x.configs);
  const active = useWs((x) => x.activeConfig);
  const mode = useWs((x) => x.mode);
  const target = useWs((x) => x.target);
  const scope = useSel((x) => x.scope);
  const focusPart = scope.mode === 'part' ? scope.part : null;
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showEmpty, setShowEmpty] = useState(false);

  if (!v) return (
    <div className="panel">
      <PanelHeader title="Parts" />
      <div className="empty-hint">Open a vehicle first.</div>
    </div>
  );

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
      <div className={'part-row' + (isTarget ? ' target' : '')} style={{ paddingLeft: 8 + depth * 12 }}>
        {p.slots.length ? (
          <button className="icon-btn small tiny" onClick={() => toggle(p.path)} aria-label="Toggle">{collapsed.has(p.path) && !q ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
        ) : <span style={{ width: 18 }} />}
        <button className="part-name" onClick={() => {
          revealRange(p.def.file, p.def.key.s, p.def.key.e);
          if (doc?.writable && !doc.isCommon) ws.setTarget(doc.key, p.def.name);
        }} title={`${p.def.name}\n${p.def.file}`}>
          {sn ? <span className="slot-label">{sn.def.description || sn.id}</span> : null}
          <span className={'mono ellipsis' + (doc?.isCommon ? ' faint' : '')}>{p.def.name}</span>
        </button>
        {!doc?.writable && <Lock size={10} className="faint" />}
        <button className={'icon-btn small tiny' + (focusPart === p.def.name ? ' active' : '')} data-tip="Isolate in 3D" data-tip-pos="left" onClick={() => (focusPart === p.def.name ? ws.setScope({ mode: 'file', file: p.def.file }) : ws.focusPart(p.def.name))} aria-label="Show only this part"><Eye size={12} /></button>
        {doc?.writable && !doc.isCommon && (
          <button className={'icon-btn small tiny' + (isTarget ? ' active' : '')} data-tip="New elements go here" data-tip-pos="left" onClick={() => ws.setTarget(doc.key, p.def.name)} aria-label="Set target"><Target size={12} /></button>
        )}
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
    <div className="panel">
      <PanelHeader title="Parts">
        <button className={'icon-btn small' + (showEmpty ? ' active' : '')} data-tip="Show empty slots" data-tip-pos="bottom-left" onClick={() => setShowEmpty(!showEmpty)} aria-label="Show empty slots"><CircleSlash size={14} /></button>
        <button className="icon-btn small" data-tip="Save configuration as .pc" data-tip-pos="bottom-left" onClick={() => command('config.save')} aria-label="Save config"><Puzzle size={14} /></button>
      </PanelHeader>
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
      <SearchBox value={q} onChange={setQ} placeholder="Filter parts / slots" />
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
      {focusPart && (
        <div className="panel-foot">
          <Crosshair size={12} /> Showing: <span className="mono ellipsis">{focusPart}</span>
          <button className="btn small ghost" onClick={() => ws.setScope({ mode: 'vehicle' })}>Whole vehicle</button>
        </div>
      )}
    </div>
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
