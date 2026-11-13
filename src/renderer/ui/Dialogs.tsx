import { useEffect, useMemo, useState } from 'react';
import { X, FolderOpen, Box, Link2, FileUp, Loader2 } from 'lucide-react';
import { useUi } from '../state/ui';
import { ws, useWs } from '../project/workspace';
import { useSettings, settings, DEFAULT_KEYMAP, keyFor } from '../state/settings';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { parseObj, planImport, type MeshData, type ImportOptions } from '@core/import/mesh';
import { DEFAULT_HEADERS, fmtRow, insertRows, rowFromRecord } from '@core/jbeam/edit';
import { targetPart, EditSet, selectNodesByName, moveNodes, setSymmetryCrossPolicy, type SymmetryResult } from '../project/ops';
import { beamKey, triKey } from '../state/selection';
import { openFolder } from './commands';
import type { BlenderExtract } from '@shared/ipc';
import type { AArr } from '@core/sjson';
import { MirrorPartDialog } from './MirrorPart';
import { GameLinkDialog } from './GameLink';

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  return (
    <div className="overlay" onPointerDown={props.onClose}>
      <div className="modal" style={{ width: props.width ?? 520 }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="dialog" aria-label={props.title}>
        <div className="modal-head">
          <span>{props.title}</span>
          <button className="icon-btn small" onClick={props.onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Dialogs() {
  const d = useUi((x) => x.dialog);
  const close = () => useUi.setState({ dialog: null });
  useEffect(() => api.onBlenderLink((data: BlenderExtract) => {
    useUi.setState({ dialog: { kind: 'import', data: { blender: data } } });
    toast('info', `Received ${data.objects?.length ?? 0} object(s) from Blender`);
  }), []);
  useEffect(() => api.onCloseRequest(() => {
    if (useWs.getState().dirtyCount > 0) useUi.setState({ dialog: { kind: 'closeConfirm' } });
    else api.confirmClose(true);
  }), []);
  if (!d) return null;
  switch (d.kind) {
    case 'newVehicle':
      return <NewVehicle close={close} />;
    case 'makeEditable':
      return <MakeEditable close={close} docKey={d.data} />;
    case 'import':
      return <ImportDialog close={close} initial={d.data} />;
    case 'mirrorPart':
      return <MirrorPartDialog part={d.data} close={close} />;
    case 'gameLink':
      return <GameLinkDialog close={close} />;
    case 'symmetryCross':
      return <SymmetryCross close={close} data={d.data} />;
    case 'shortcuts':
      return <Shortcuts close={close} />;
    case 'blenderAddon':
      return <BlenderAddon close={close} />;
    case 'closeConfirm':
      return (
        <Modal title="Unsaved changes" onClose={close} footer={<>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn danger" onClick={() => api.confirmClose(true)}>Discard &amp; quit</button>
          <button className="btn primary" onClick={async () => { await ws.saveAll(); api.confirmClose(true); }}>Save all &amp; quit</button>
        </>}>
          <div>{useWs.getState().dirtyCount} file(s) have unsaved changes.</div>
        </Modal>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------

function NewVehicle({ close }: { close: () => void }) {
  const s = settings();
  const [mod, setMod] = useState('my_vehicle_mod');
  const [model, setModel] = useState('my_vehicle');
  const [title, setTitle] = useState('My Vehicle');
  const [author, setAuthor] = useState('');
  const [template, setTemplate] = useState<'box' | 'empty'>('box');
  const [busy, setBusy] = useState(false);
  const root = s.userDir ? `${s.userDir}\\mods\\unpacked\\${mod}` : '';
  const valid = /^[a-z0-9_]+$/i.test(model) && /^[\w.-]+$/.test(mod) && !!root;
  const create = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const dir = `${root}\\vehicles\\${model}`;
      const exists = await api.stat(dir);
      if (exists) {
        toast('warn', 'That vehicle folder already exists');
        return;
      }
      const box = template === 'box';
      const jbeam = `{
"${model}_body": {
    "information": {
        "authors": "${author || 'me'}",
        "name": "${title} Body",
        "value": 1000
    },
    "slotType": "main",
    "slots2": [
        ["name", "allowTypes", "denyTypes", "default", "description"],
    ],
    "refNodes": [
        ["ref:", "back:", "left:", "up:"],
        ["b1", "b5", "b2", "b3"],
    ],
    "cameraExternal": {"distance": 5, "distanceMin": 3, "offset": {"x": 0, "y": 0, "z": 0.6}, "fov": 65},
    "nodes": [
        ["id", "posX", "posY", "posZ"],
        {"nodeWeight": 20},
        {"collision": true},
        {"selfCollision": false},
        {"nodeMaterial": "|NM_METAL"},
        {"frictionCoef": 0.7},
        {"group": "${model}_body"},${box ? `
        ["b1", 0.5, -1.0, 0.3],
        ["b2", -0.5, -1.0, 0.3],
        ["b3", 0.5, -1.0, 1.0],
        ["b4", -0.5, -1.0, 1.0],
        ["b5", 0.5, 1.0, 0.3],
        ["b6", -0.5, 1.0, 0.3],
        ["b7", 0.5, 1.0, 1.0],
        ["b8", -0.5, 1.0, 1.0],` : ''}
        {"group": ""},
    ],
    "beams": [
        ["id1:", "id2:"],
        {"beamType": "|NORMAL", "beamPrecompression": 1, "beamLongBound": 1.0, "beamShortBound": 1.0},
        {"beamSpring": 1501000, "beamDamp": 150},
        {"beamDeform": 80000, "beamStrength": "FLT_MAX"},${box ? `
        ["b1", "b2"], ["b3", "b4"], ["b5", "b6"], ["b7", "b8"],
        ["b1", "b3"], ["b2", "b4"], ["b5", "b7"], ["b6", "b8"],
        ["b1", "b5"], ["b2", "b6"], ["b3", "b7"], ["b4", "b8"],
        ["b1", "b4"], ["b5", "b8"], ["b1", "b6"], ["b3", "b8"], ["b1", "b7"], ["b2", "b8"], ["b1", "b8"],` : ''}
    ],
    "triangles": [
        ["id1:", "id2:", "id3:"],
        {"groundModel": "metal"},${box ? `
        ["b1", "b3", "b2"], ["b2", "b3", "b4"],
        ["b5", "b6", "b7"], ["b6", "b8", "b7"],
        ["b1", "b2", "b5"], ["b2", "b6", "b5"],
        ["b3", "b7", "b4"], ["b4", "b7", "b8"],
        ["b1", "b5", "b3"], ["b3", "b5", "b7"],
        ["b2", "b4", "b6"], ["b4", "b8", "b6"],` : ''}
        {"groundModel": ""},
    ],
},
}
`;
      const info = JSON.stringify({ Name: title, Brand: '', Author: author || 'me', Type: 'Car', default_pc: '' }, null, 2);
      await api.writeTextFile(`${dir}\\${model}.jbeam`, jbeam);
      await api.writeTextFile(`${dir}\\info.json`, info);
      await openFolder(root);
      toast('ok', `Created ${model} in mods/unpacked/${mod}`);
      close();
    } catch (e: any) {
      toast('error', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New vehicle" onClose={close} footer={<>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!valid || busy} onClick={create}>{busy ? <Loader2 size={13} className="spin" /> : null} Create</button>
    </>}>
      <Field label="Mod folder name" hint={root || 'BeamNG user folder not found — set it in Settings → Files'}>
        <input className="input" value={mod} onChange={(e) => setMod(e.target.value)} />
      </Field>
      <Field label="Vehicle id (folder name)" hint="lowercase letters, digits and _ ; used as vehicles/<id>/">
        <input className="input mono" value={model} onChange={(e) => setModel(e.target.value.toLowerCase())} />
      </Field>
      <Field label="Display name"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Author"><input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} /></Field>
      <Field label="Start from">
        <div className="segmented">
          <button className={'seg' + (template === 'box' ? ' active' : '')} onClick={() => setTemplate('box')}>Box (spawnable)</button>
          <button className={'seg' + (template === 'empty' ? ' active' : '')} onClick={() => setTemplate('empty')}>Empty part</button>
        </div>
      </Field>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------

function MakeEditable({ close, docKey }: { close: () => void; docKey: string }) {
  const d = ws.doc(docKey);
  const s = settings();
  const [mods, setMods] = useState<string[]>([]);
  const [mod, setMod] = useState('');
  const [newMod, setNewMod] = useState('');
  useEffect(() => {
    if (!s.userDir) return;
    api.listDir(`${s.userDir}\\mods\\unpacked`).then((l) => {
      const list = l.filter((e) => e.dir).map((e) => e.name);
      setMods(list);
      const guess = list.find((m) => ws.model && m.toLowerCase().includes(ws.model.toLowerCase()));
      setMod(guess ?? list[0] ?? '');
    }).catch(() => {});
  }, []);
  if (!d) return null;
  const root = newMod ? `${s.userDir}\\mods\\unpacked\\${newMod}` : mod ? `${s.userDir}\\mods\\unpacked\\${mod}` : '';
  return (
    <Modal title="Make editable copy" onClose={close} footer={<>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!root} onClick={async () => {
        if (await ws.makeEditable(d.key, root)) {
          toast('ok', `${d.name} copied to ${root.split('\\').pop()} — it now overrides the original`);
          close();
        }
      }}>Copy &amp; edit</button>
    </>}>
      <div className="dim" style={{ marginBottom: 10 }}>
        <span className="mono">{d.vpath}</span> comes from <b>{d.source}</b> and is read-only. A copy is placed in an unpacked mod at the same path, which overrides the original in game.
      </div>
      <Field label="Existing mod">
        <select className="select" value={mod} onChange={(e) => { setMod(e.target.value); setNewMod(''); }}>
          {mods.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="…or a new mod folder"><input className="input" value={newMod} placeholder="new_mod_name" onChange={(e) => setNewMod(e.target.value.replace(/[^\w.-]/g, ''))} /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------

function ImportDialog({ close, initial }: { close: () => void; initial?: { blender?: BlenderExtract } }) {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const v = useWs((x) => x.vehicle);
  const [meshes, setMeshes] = useState<MeshData[]>(() => (initial?.blender ? fromBlender(initial.blender) : []));
  const [source, setSource] = useState(initial?.blender ? 'Blender live link' : '');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState<ImportOptions>({
    prefix: settings().namingPrefix,
    start: settings().namingStart,
    suffixL: s.mirrorSuffixLeft,
    suffixR: s.mirrorSuffixRight,
    centerTol: s.namingCenterTolerance,
    mergeTol: s.importMergeTolerance,
    makeBeams: s.importMakeBeams,
    makeTris: s.importMakeTris,
    order: 'front-to-back',
    groupPrefix: false,
  });
  useEffect(() => setEnabled(new Set(meshes.map((m) => m.name))), [meshes]);
  const target = targetPart();

  const plan = useMemo(() => {
    const chosen = meshes.filter((m) => enabled.has(m.name));
    if (!chosen.length) return null;
    const existing = (v?.nodes ?? []).map((n) => ({ name: n.name, x: n.x, y: n.y, z: n.z }));
    const eb = new Set((v?.beams ?? []).map((b) => beamKey(v!.nodes[b.a].name, v!.nodes[b.b].name)));
    const et = new Set((v?.tris ?? []).map((t) => triKey(v!.nodes[t.a].name, v!.nodes[t.b].name, v!.nodes[t.c].name)));
    return planImport(chosen, existing, eb, et, opts);
  }, [meshes, enabled, opts, v]);

  const loadObj = async () => {
    const p = await api.pickFile({ title: 'Import OBJ', filters: [{ name: 'Wavefront OBJ', extensions: ['obj'] }] });
    if (!p) return;
    const text = await api.readTextFile(p);
    const m = parseObj(text, s.blenderAxis === 'y-up' ? 'y-up' : 'z-up');
    setMeshes(m);
    setSource(p.split(/[\\/]/).pop()!);
    if (!m.length) toast('warn', 'No vertices found in that OBJ');
  };
  const loadBlend = async () => {
    let exe = s.blenderExe;
    if (!exe) {
      const found = await api.blenderFind();
      exe = found[0] ?? '';
      if (exe) set({ blenderExe: exe });
    }
    if (!exe) {
      toast('warn', 'Blender not found. Set its path in Settings → Blender.');
      return;
    }
    const p = await api.pickFile({ title: 'Import .blend', filters: [{ name: 'Blender file', extensions: ['blend'] }] });
    if (!p) return;
    setBusy(true);
    try {
      const res = await api.blenderExtract(exe, p);
      if (!res.ok) {
        toast('error', 'Blender: ' + (res.error ?? 'failed'));
        return;
      }
      setMeshes(fromBlender(res));
      setSource(`${p.split(/[\\/]/).pop()} (Blender ${res.blenderVersion ?? ''})`);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!plan || !target) return;
    const { doc, part } = target;
    const text = doc.text;
    const es = new EditSet();
    const hdr = (sec: string) => {
      const t = part.sections.get(sec);
      if (t && t.k === 'arr' && t.items[0]?.k === 'arr') return (t.items[0] as AArr).items.map((x) => (x.k === 'str' ? x.v : ''));
      return DEFAULT_HEADERS[sec];
    };
    const dec = settings().decimals;
    if (plan.newNodes.length) {
      const h = hdr('nodes');
      es.add(doc.key, insertRows(text, part, 'nodes', h, plan.newNodes.map((n) => fmtRow(rowFromRecord(h, { id: n.name, posX: r(n.x, dec), posY: r(n.y, dec), posZ: r(n.z, dec), ...(n.group && opts.groupPrefix === false ? { group: n.group } : {}) }), dec))));
    }
    if (plan.beams.length) {
      const h = hdr('beams');
      es.add(doc.key, insertRows(text, part, 'beams', h, plan.beams.map(([a, b]) => fmtRow(rowFromRecord(h, { 'id1:': a, 'id2:': b })))));
    }
    if (plan.tris.length) {
      const h = hdr('triangles');
      es.add(doc.key, insertRows(text, part, 'triangles', h, plan.tris.map(([a, b, c]) => fmtRow(rowFromRecord(h, { 'id1:': a, 'id2:': b, 'id3:': c })))));
    }
    if (es.apply(`Import ${source || 'mesh'}`)) {
      toast('ok', `Imported ${plan.newNodes.length} nodes, ${plan.beams.length} beams, ${plan.tris.length} triangles into ${part.name}`);
      selectNodesByName(plan.newNodes.map((n) => n.name));
      set({ importMergeTolerance: opts.mergeTol, importMakeBeams: opts.makeBeams, importMakeTris: opts.makeTris, namingPrefix: opts.prefix });
      close();
    }
  };

  const o = (patch: Partial<ImportOptions>) => setOpts({ ...opts, ...patch });
  return (
    <Modal title="Import from Blender / OBJ" width={640} onClose={close} footer={<>
      <span className="grow dim small-text">Target: {target ? <span className="mono">{target.part.name}</span> : <span className="warn-text">no writable part — open a mod vehicle</span>}</span>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!plan || !target || (!plan.newNodes.length && !plan.beams.length && !plan.tris.length)} onClick={apply}>Import</button>
    </>}>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn" onClick={loadObj}><FileUp size={14} /> OBJ file…</button>
        <button className="btn" onClick={loadBlend} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <Box size={14} />} .blend file…</button>
        <button className="btn" onClick={() => useUi.setState({ dialog: { kind: 'blenderAddon' } })}><Link2 size={14} /> Live link add-on</button>
      </div>
      {source && <div className="dim" style={{ marginBottom: 8 }}>Source: <b>{source}</b></div>}
      {meshes.length > 0 && (
        <div className="import-objects">
          {meshes.map((m) => (
            <label key={m.name} className="row">
              <input type="checkbox" checked={enabled.has(m.name)} onChange={() => {
                const n = new Set(enabled);
                if (n.has(m.name)) n.delete(m.name);
                else n.add(m.name);
                setEnabled(n);
              }} />
              <span className="mono">{m.name}</span>
              <span className="faint">{m.verts.length / 3} verts · {m.edges.length / 2} edges · {m.tris.length / 3} tris</span>
            </label>
          ))}
        </div>
      )}
      <div className="grid2">
        <Field label="Name prefix"><input className="input mono" value={opts.prefix} onChange={(e) => o({ prefix: e.target.value })} /></Field>
        <Field label="Start number"><input className="input" type="number" value={opts.start} onChange={(e) => o({ start: +e.target.value | 0 })} /></Field>
        <Field label="Numbering order">
          <select className="select" value={opts.order} onChange={(e) => o({ order: e.target.value as any })}>
            <option value="front-to-back">Front → back</option>
            <option value="top-to-bottom">Top → bottom</option>
            <option value="index">Vertex order</option>
          </select>
        </Field>
        <Field label="Weld / match tolerance (m)" hint="Vertices this close to an existing node keep its name"><input className="input" type="number" step={0.0005} value={opts.mergeTol} onChange={(e) => o({ mergeTol: Math.max(0, +e.target.value) })} /></Field>
        <label className="row"><input type="checkbox" checked={opts.makeBeams} onChange={(e) => o({ makeBeams: e.target.checked })} /> Edges → beams</label>
        <label className="row"><input type="checkbox" checked={opts.makeTris} onChange={(e) => o({ makeTris: e.target.checked })} /> Faces → collision triangles</label>
        <label className="row"><input type="checkbox" checked={opts.groupPrefix} onChange={(e) => o({ groupPrefix: e.target.checked })} /> Vertex group name as prefix</label>
      </div>
      {plan && (
        <div className="import-summary">
          <div><b>{plan.newNodes.length}</b> new nodes <span className="faint">({plan.matched} matched existing)</span></div>
          <div><b>{plan.beams.length}</b> new beams <span className="faint">({plan.skippedBeams} already exist)</span></div>
          <div><b>{plan.tris.length}</b> new triangles <span className="faint">({plan.skippedTris} already exist)</span></div>
          {plan.newNodes.length > 0 && <div className="faint mono small-text ellipsis">{plan.newNodes.slice(0, 12).map((n) => n.name).join(', ')}{plan.newNodes.length > 12 ? '…' : ''}</div>}
        </div>
      )}
      {!meshes.length && <div className="empty-hint">Model the node/beam layout in Blender with vertices, edges and faces, then import it here. Vertices are named automatically with l/r suffixes by side; mirror twins share a number. Re-import any time: existing nodes are matched by position.</div>}
    </Modal>
  );
}

function r(x: number, dec: number) {
  const f = Math.pow(10, dec);
  return Math.round(x * f) / f;
}

function fromBlender(res: BlenderExtract): MeshData[] {
  return (res.objects ?? []).map((o) => ({ name: o.name, verts: o.verts, edges: o.edges, tris: o.tris, vertGroup: o.vertGroup, groups: o.vertexGroups }));
}

// ------------------------------------------------------------------------------------------

function BlenderAddon({ close }: { close: () => void }) {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const [found, setFound] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.blenderFind().then((f) => {
      setFound(f);
      if (!s.blenderExe && f[0]) set({ blenderExe: f[0] });
    });
  }, []);
  return (
    <Modal title="Blender live link" onClose={close} width={600} footer={<>
      <button className="btn" onClick={close}>Close</button>
      <button className="btn primary" disabled={!s.blenderExe || busy} onClick={async () => {
        setBusy(true);
        const r = await api.installBlenderAddon(s.blenderExe);
        setBusy(false);
        setMsg(r.message);
        if (r.ok) toast('ok', 'Blender add-on installed');
      }}>{busy && <Loader2 size={13} className="spin" />} Install add-on</button>
    </>}>
      <div className="dim" style={{ marginBottom: 10 }}>
        The add-on adds an <b>EditorNG</b> tab to Blender's 3D viewport sidebar (N). <b>Send to EditorNG</b> pushes the selected mesh objects (vertices, edges, faces, vertex groups) straight into the import dialog here. Turn on <b>Auto-send</b> and every edit in Blender updates EditorNG.
      </div>
      <Field label="Blender executable" hint={found.length ? `Found: ${found.join(', ')}` : 'No Blender installation found automatically'}>
        <div className="row">
          <input className="input grow mono" value={s.blenderExe} onChange={(e) => set({ blenderExe: e.target.value })} />
          <button className="btn" onClick={async () => {
            const p = await api.pickFile({ title: 'blender.exe', filters: [{ name: 'Blender', extensions: ['exe'] }] });
            if (p) set({ blenderExe: p });
          }}><FolderOpen size={14} /></button>
        </div>
      </Field>
      <Field label="Live link port" hint="EditorNG listens on 127.0.0.1 at this port"><input className="input" type="number" value={s.linkPort} onChange={(e) => set({ linkPort: +e.target.value | 0 })} /></Field>
      {msg && <div className="note">{msg}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------

const SHORTCUT_GROUPS: Array<[string, string[]]> = [
  ['Tools', ['add.menu', 'tool.select', 'tool.addNode', 'tool.beam', 'tool.tri', 'tool.name']],
  ['Transform', ['transform.grab', 'transform.scale', 'transform.rotate', 'edit.symmetry', 'edit.snapRail']],
  ['Edit', ['edit.extrude', 'edit.merge', 'edit.connect', 'edit.flipTri', 'edit.delete', 'edit.rename', 'edit.mirror', 'edit.duplicate', 'edit.undo', 'edit.redo']],
  ['Select', ['select.all', 'select.none', 'select.invert', 'select.grow', 'select.shrink', 'select.linked', 'select.mirror', 'mode.nodes', 'mode.beams', 'mode.tris']],
  ['View', ['view.hide', 'view.hideOthers', 'view.unhide', 'view.frame', 'view.frameAll', 'view.front', 'view.side', 'view.top', 'view.ortho', 'view.toggleLabels', 'view.toggleMeshes', 'view.isolatePart', 'view.xray']],
  ['Game', ['game.reload']],
  ['App', ['app.save', 'app.saveAll', 'app.palette', 'app.quickOpen', 'app.gotoNode', 'app.settings', 'app.toggleEditor', 'app.toggleBottom', 'app.reload']],
];

export const ACTION_LABELS: Record<string, string> = {
  'add.menu': 'Add menu (node, beam, trigger, bulb, wheel…)',
  'game.reload': 'Save all and reload the vehicle in BeamNG',
  'view.hide': 'Hide selected nodes', 'view.hideOthers': 'Hide everything else', 'view.unhide': 'Unhide all',
  'edit.extrude': 'Extrude nodes (then move)', 'select.grow': 'Grow selection', 'select.shrink': 'Shrink selection', 'edit.merge': 'Merge nodes into the active one',
  'edit.symmetry': 'Toggle X symmetry (mirror twins move too)', 'edit.snapRail': 'Snap slidenodes onto their rail',
  'select.all': 'Select all', 'select.none': 'Select none', 'select.invert': 'Invert selection', 'select.linked': 'Select linked (same part)', 'select.mirror': 'Add mirror twins to selection',
  'transform.grab': 'Move (X/Y/Z lock, type value)', 'transform.scale': 'Scale (S then X then -1 mirrors)', 'transform.rotate': 'Rotate',
  'tool.select': 'Select tool', 'tool.addNode': 'Add node tool', 'tool.beam': 'Beam chain tool', 'tool.tri': 'Triangle tool', 'tool.name': 'Quick naming tool',
  'edit.connect': '2 nodes → beam, 3 → triangle, more → chain', 'edit.flipTri': 'Flip triangle normals', 'edit.delete': 'Delete', 'edit.deleteAlt': 'Delete (alt)', 'edit.rename': 'Rename node (Tab: next)',
  'edit.mirror': 'Mirror to other side', 'edit.duplicate': 'Duplicate & move', 'edit.undo': 'Undo', 'edit.redo': 'Redo', 'edit.redoAlt': 'Redo (alt)',
  'view.frame': 'Frame selection', 'view.frameSelected': 'Frame selection (numpad)', 'view.frameAll': 'Frame all', 'view.front': 'Front view', 'view.back': 'Back view', 'view.side': 'Right view',
  'view.sideOther': 'Left view', 'view.top': 'Top view', 'view.bottom': 'Bottom view', 'view.ortho': 'Toggle ortho', 'view.toggleLabels': 'Toggle all labels',
  'view.toggleMeshes': 'Toggle flexbodies', 'view.isolatePart': 'Isolate part', 'view.xray': 'X-ray',
  'mode.nodes': 'Pick nodes only', 'mode.beams': 'Pick beams only', 'mode.tris': 'Pick triangles only',
  'app.save': 'Save file', 'app.saveAll': 'Save all', 'app.palette': 'Command palette', 'app.quickOpen': 'Go to file', 'app.gotoNode': 'Go to node', 'app.settings': 'Settings',
  'app.toggleEditor': 'Toggle code editor', 'app.toggleBottom': 'Toggle bottom panel', 'app.reload': 'Reload from disk',
};

function Shortcuts({ close }: { close: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={760}>
      <div className="shortcuts">
        {SHORTCUT_GROUPS.map(([g, ids]) => (
          <div key={g}>
            <div className="group-label">{g}</div>
            {ids.map((id) => (
              <div key={id} className="shortcut-row"><span>{ACTION_LABELS[id] ?? id}</span><span className="kbd">{keyFor(id)}</span></div>
            ))}
          </div>
        ))}
        <div>
          <div className="group-label">Mouse</div>
          <div className="shortcut-row"><span>Orbit</span><span className="kbd">{settings().orbitButton === 'middle' ? 'MMB drag' : 'RMB drag'}</span></div>
          <div className="shortcut-row"><span>Pan</span><span className="kbd">{settings().orbitButton === 'middle' ? 'Shift+MMB drag' : 'MMB drag'}</span></div>
          <div className="shortcut-row"><span>Context menu</span><span className="kbd">RMB click</span></div>
          <div className="shortcut-row"><span>Zoom</span><span className="kbd">Wheel</span></div>
          <div className="shortcut-row"><span>Slide along rail</span><span className="kbd">G G</span></div>
          <div className="shortcut-row"><span>Increments while moving</span><span className="kbd">hold Alt</span></div>
          <div className="shortcut-row"><span>Select shortest path</span><span className="kbd">Ctrl+click</span></div>
          <div className="shortcut-row"><span>Snap to node / mesh vertex while moving</span><span className="kbd">hold Ctrl</span></div>
          <div className="shortcut-row"><span>Box select</span><span className="kbd">LMB drag</span></div>
          <div className="shortcut-row"><span>Rename node</span><span className="kbd">Double-click</span></div>
          <div className="shortcut-row"><span>Pick meshes / props / triggers</span><span className="kbd">Alt+click</span></div>
        </div>
      </div>
      <div className="faint small-text" style={{ marginTop: 10 }}>All shortcuts can be changed in Settings → Keymap. Defaults: {Object.keys(DEFAULT_KEYMAP).length} actions.</div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------

/** Symmetry move that would also move nodes of another part (e.g. fender_R moving fender_L). */
function SymmetryCross({ close, data }: { close: () => void; data: { result: SymmetryResult; own: Map<number, [number, number, number]>; label: string; onCancel?: () => void } }) {
  const [remember, setRemember] = useState(false);
  const { result, label } = data;
  const parts = [...new Set(result.cross.map((c) => c.part))];
  const finish = (mode: 'both' | 'own' | 'cancel') => {
    close();
    if (mode === 'cancel') {
      data.onCancel?.();
      return;
    }
    if (remember) setSymmetryCrossPolicy(mode);
    const m = new Map(result.all);
    if (mode === 'own') for (const c of result.cross) m.delete(c.idx);
    if (!moveNodes(m, label + (m.size > data.own.size ? ' (symmetry)' : ''))) data.onCancel?.();
  };
  return (
    <Modal title="Symmetry: also move the other side?" onClose={() => finish('cancel')} width={500} footer={<>
      <label className="row dim" style={{ gap: 6, marginRight: 'auto' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Don't ask again this session
      </label>
      <button className="btn" onClick={() => finish('own')}>Only this side</button>
      <button className="btn primary" autoFocus onClick={() => finish('both')}>Move both</button>
    </>}>
      <div style={{ marginBottom: 8 }}>
        The mirror twin{result.cross.length === 1 ? '' : 's'} of the moved node{data.own.size === 1 ? '' : 's'} live{result.cross.length === 1 ? 's' : ''} in {parts.length === 1 ? 'another part' : 'other parts'}: <b className="mono">{parts.join(', ')}</b>.
      </div>
      <div className="sym-list mono">
        {result.cross.slice(0, 12).map((c) => (
          <div key={c.idx}>{c.from} <span className="faint">({c.fromPart})</span> → <b>{c.name}</b> <span className="faint">({c.part})</span></div>
        ))}
        {result.cross.length > 12 && <div className="faint">…and {result.cross.length - 12} more</div>}
      </div>
    </Modal>
  );
}
