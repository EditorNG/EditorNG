import { useEffect, useMemo, useState } from 'react';
import { X, FolderOpen, Box, Link2, FileUp, Loader2 } from 'lucide-react';
import { useUi } from '../state/ui';
import { ws, useWs } from '../project/workspace';
import { useSettings, settings, DEFAULT_KEYMAP, keyFor } from '../state/settings';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { parseObj, planImport, type MeshData, type ImportOptions } from '@core/import/mesh';
import { DEFAULT_HEADERS, fmtRow, rowFromRecord, insertKey, indentUnitOf, eolOf } from '@core/jbeam/edit';
import { targetPart, EditSet, insertRowsHere, selectNodesByName, moveNodes, setSymmetryCrossPolicy, type SymmetryResult } from '../project/ops';
import { beamKey, triKey } from '../state/selection';
import type { BlenderExtract } from '@shared/ipc';
import type { AArr } from '@core/sjson';
import { MirrorPartDialog } from './MirrorPart';
import { GameLinkDialog } from './GameLink';
import { DeleteRefsDialog, DiffDialog } from './Tier2';
import { PackModDialog } from './PackMod';
import { MergeDialog } from './MergeDialog';
import { NewPartDialog, FlexbodyDialog } from './AddDialogs';
import { NewModDialog } from './NewMod';

export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // a popup inside the dialog (search list…) closes itself first
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('[data-own-esc]') && !document.querySelector('.guide-card')) {
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
    case 'newMod':
      return <NewModDialog close={close} data={d.data} />;
    case 'makeEditable':
      return <MakeEditable close={close} docKey={d.data} />;
    case 'import':
      return <ImportDialog close={close} initial={d.data} />;
    case 'mirrorPart':
      return <MirrorPartDialog part={d.data} close={close} />;
    case 'deleteRefs':
      return <DeleteRefsDialog close={close} data={d.data} />;
    case 'diff':
      return <DiffDialog close={close} data={d.data} />;
    case 'newPart':
      return <NewPartDialog close={close} data={d.data} />;
    case 'flexbody':
      return <FlexbodyDialog close={close} data={d.data} />;
    case 'merge':
      return <MergeDialog close={close} data={d.data} />;
    case 'packMod':
      return <PackModDialog close={close} />;
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

  // ---- destination: a new part (default) or an existing one
  const docs = useWs((x) => x.docs);
  const model = useWs((x) => x.model);
  const writableDocs = [...docs.values()].filter((d) => d.writable && !d.isCommon && d.lang === 'jbeam' && !d.binary);
  const writableParts = writableDocs.flatMap((d) => (d.jfile?.parts ?? []).map((p) => ({ key: d.key + '#' + p.name, doc: d, part: p })));
  const rootDoc = v?.root ? ws.doc(v.root.def.file) : undefined;
  const homeDoc = rootDoc?.writable && !rootDoc.isCommon ? rootDoc : writableDocs[0];
  const objName = (meshes.find((m) => enabled.has(m.name)) ?? meshes[0])?.name ?? 'part';
  const baseName = objName.replace(/\.(jbeam|obj|blend)$/i, '').replace(/[^A-Za-z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';
  const suggested = model && !baseName.toLowerCase().startsWith(model.toLowerCase() + '_') ? `${model}_${baseName}` : baseName;
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [partName, setPartName] = useState('');
  const [slotType, setSlotType] = useState('');
  const [slotTouched, setSlotTouched] = useState(false);
  const [display, setDisplay] = useState('');
  const [value, setValue] = useState(100);
  const [fileKey, setFileKey] = useState(''); // '' = new file
  const [newFile, setNewFile] = useState('');
  const [plugInto, setPlugInto] = useState<string>(v?.root && homeDoc === rootDoc ? v.root.def.name : '');
  const [existingKey, setExistingKey] = useState(() => {
    const t = targetPart();
    return t ? t.doc.key + '#' + t.part.name : '';
  });
  // defaults follow the Blender object until the user types
  useEffect(() => {
    setPartName(suggested);
    setDisplay(baseName.replace(/_/g, ' '));
    setNewFile(baseName + '.jbeam');
    if (!slotTouched) setSlotType(suggested);
    // re-sending an object that was imported before: update that part
    api.stateLoad().then((st) => {
      const prev = st.importTargets?.[objName];
      const hit = prev && writableParts.find((p) => p.part.name === prev);
      if (hit) {
        setMode('existing');
        setExistingKey(hit.key);
      }
    });
  }, [objName]);
  const existing = writableParts.find((p) => p.key === existingKey);
  const target = mode === 'existing' ? (existing ? { doc: existing.doc, part: existing.part } : null) : null;
  const nameTaken = mode === 'new' && !!partName && !!ws.partDef(partName);
  const nameBad = mode === 'new' && !/^[A-Za-z0-9_\-]+$/.test(partName);

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

  const rowsFor = (h: Record<string, string[]>) => {
    const dec = settings().decimals;
    return {
      nodes: plan!.newNodes.map((n) => fmtRow(rowFromRecord(h.nodes, { id: n.name, posX: r(n.x, dec), posY: r(n.y, dec), posZ: r(n.z, dec), ...(n.group && opts.groupPrefix === false ? { group: n.group } : {}) }), dec)),
      beams: plan!.beams.map(([a, b]) => fmtRow(rowFromRecord(h.beams, { 'id1:': a, 'id2:': b }))),
      tris: plan!.tris.map(([a, b, c]) => fmtRow(rowFromRecord(h.triangles, { 'id1:': a, 'id2:': b, 'id3:': c }))),
    };
  };

  /** A new part: information + slotType + the imported tables, at the given indentation. */
  const partBody = (ind: string, unit: string, eol: string) => {
    const i1 = ind + unit, i2 = i1 + unit;
    const rows = rowsFor(DEFAULT_HEADERS as any);
    const table = (key: string, header: string[], list: string[]) => (list.length ? [i1 + JSON.stringify(key) + ': [', i2 + fmtRow(header) + ',', ...list.map((x) => i2 + x + ','), i1 + '],'] : []);
    return [
      '{',
      i1 + '"information":{',
      i2 + '"authors":' + JSON.stringify(s.modAuthor || 'me') + ',',
      i2 + '"name":' + JSON.stringify(display || partName) + ',',
      i2 + '"value":' + (Number.isFinite(value) ? value : 0) + ',',
      i1 + '},',
      i1 + '"slotType" : ' + JSON.stringify(slotType || partName) + ',',
      ...table('nodes', DEFAULT_HEADERS.nodes, rows.nodes),
      ...table('beams', DEFAULT_HEADERS.beams, rows.beams),
      ...table('triangles', DEFAULT_HEADERS.triangles, rows.tris),
      ind + '}',
    ].join(eol);
  };

  const remember = async (part: string) => {
    const st = await api.stateLoad();
    const map = { ...(st.importTargets ?? {}) };
    for (const m of meshes) if (enabled.has(m.name)) map[m.name] = part;
    await api.stateSave({ ...st, importTargets: map });
  };

  const applyNew = async () => {
    if (!plan || nameBad || nameTaken) return;
    const es = new EditSet();
    const display2 = display || partName;
    let fileDoc = fileKey ? ws.doc(fileKey) : undefined;
    if (fileDoc) {
      const t = fileDoc.text;
      const unit = indentUnitOf(t);
      const rootObj = fileDoc.jfile?.root;
      if (!rootObj || rootObj.k !== 'obj') {
        toast('error', `${fileDoc.name} has no top-level object to add a part to`);
        return;
      }
      es.add(fileDoc.key, insertKey(t, rootObj, partName, (ind) => partBody(ind, unit, eolOf(t))));
    } else {
      if (!homeDoc?.ref.real) {
        toast('warn', 'No editable vehicle folder: open a mod vehicle (or make a file editable) first');
        return;
      }
      const fname = /\.jbeam$/i.test(newFile) ? newFile : newFile + '.jbeam';
      const dirReal = homeDoc.ref.real.replace(/[\\/][^\\/]*$/, '');
      const dirV = homeDoc.vpath.replace(/\/[^/]*$/, '');
      if (ws.doc(dirV + '/' + fname)) {
        toast('warn', `${fname} already exists: pick it under "File" instead`);
        return;
      }
      const text = '{\n    ' + JSON.stringify(partName) + ': ' + partBody('    ', '    ', '\n') + ',\n}\n';
      fileDoc = await ws.createFile(dirV + '/' + fname, dirReal + '\\' + fname, text, true);
    }
    // plug it into a parent part so it shows up in the vehicle
    const parent = plugInto ? ws.partDef(plugInto) : undefined;
    const parentDoc = parent ? ws.doc(parent.file) : undefined;
    if (parent && parentDoc) {
      const useV1 = parent.sections.has('slots') && !parent.sections.has('slots2');
      const sec = useV1 ? 'slots' : 'slots2';
      const t = parent.sections.get(sec);
      const header = t && t.k === 'arr' && t.items[0]?.k === 'arr' ? (t.items[0] as AArr).items.map((x) => (x.k === 'str' ? x.v : '')) : useV1 ? ['type', 'default', 'description'] : DEFAULT_HEADERS.slots2;
      const rec = useV1 ? { type: slotType || partName, default: partName, description: display2 } : { name: slotType || partName, allowTypes: [slotType || partName], denyTypes: [], default: partName, description: display2 };
      es.add(parentDoc.key, insertRowsHere(parentDoc.text, parent, sec, header, [fmtRow(rowFromRecord(header, rec))]));
    }
    if (es.size) es.apply(`New part ${partName}`);
    else ws.assemble();
    await remember(partName);
    set({ importMergeTolerance: opts.mergeTol, importMakeBeams: opts.makeBeams, importMakeTris: opts.makeTris, namingPrefix: opts.prefix });
    toast('ok', `Created ${partName}: ${plan.newNodes.length} nodes, ${plan.beams.length} beams, ${plan.tris.length} triangles${fileKey ? '' : ' (new file, unsaved)'}`);
    close();
    setTimeout(() => {
      if (!ws.focusPart(partName) && fileDoc) ws.setScope({ mode: 'file', file: fileDoc.key });
      selectNodesByName(plan.newNodes.map((n) => n.name));
    }, 50);
  };

  const apply = () => {
    if (mode === 'new') {
      applyNew();
      return;
    }
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
      es.add(doc.key, insertRowsHere(text, part, 'nodes', h, plan.newNodes.map((n) => fmtRow(rowFromRecord(h, { id: n.name, posX: r(n.x, dec), posY: r(n.y, dec), posZ: r(n.z, dec), ...(n.group && opts.groupPrefix === false ? { group: n.group } : {}) }), dec))));
    }
    if (plan.beams.length) {
      const h = hdr('beams');
      es.add(doc.key, insertRowsHere(text, part, 'beams', h, plan.beams.map(([a, b]) => fmtRow(rowFromRecord(h, { 'id1:': a, 'id2:': b })))));
    }
    if (plan.tris.length) {
      const h = hdr('triangles');
      es.add(doc.key, insertRowsHere(text, part, 'triangles', h, plan.tris.map(([a, b, c]) => fmtRow(rowFromRecord(h, { 'id1:': a, 'id2:': b, 'id3:': c })))));
    }
    if (es.apply(`Import ${source || 'mesh'}`)) {
      toast('ok', `Imported ${plan.newNodes.length} nodes, ${plan.beams.length} beams, ${plan.tris.length} triangles into ${part.name}`);
      selectNodesByName(plan.newNodes.map((n) => n.name));
      set({ importMergeTolerance: opts.mergeTol, importMakeBeams: opts.makeBeams, importMakeTris: opts.makeTris, namingPrefix: opts.prefix });
      remember(part.name);
      close();
    }
  };

  const o = (patch: Partial<ImportOptions>) => setOpts({ ...opts, ...patch });
  return (
    <Modal title="Import from Blender / OBJ" width={640} onClose={close} footer={<>
      <span className="grow dim small-text">
        {mode === 'new'
          ? nameBad ? <span className="warn-text">Part names: letters, digits, _ and - only</span> : nameTaken ? <span className="warn-text">A part named {partName} already exists</span> : <>Creates <span className="mono">{partName}</span>{fileKey ? <> in <span className="mono">{ws.doc(fileKey)?.name}</span></> : <> in a new <span className="mono">{newFile}</span></>}</>
          : <>Into <span className="mono">{target ? target.part.name : '—'}</span></>}
      </span>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!plan || (mode === 'existing' ? !target : nameBad || nameTaken || (!fileKey && !homeDoc)) || (!plan.newNodes.length && !plan.beams.length && !plan.tris.length)} onClick={apply}>{mode === 'new' ? 'Create part' : 'Import'}</button>
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
      <div className="import-dest">
        <div className="segmented">
          <button className={'seg' + (mode === 'new' ? ' active' : '')} onClick={() => setMode('new')}>New part</button>
          <button className={'seg' + (mode === 'existing' ? ' active' : '')} onClick={() => setMode('existing')} disabled={!writableParts.length}>Add to an existing part</button>
        </div>
        {mode === 'new' ? (
          <div className="grid2">
            <Field label="Part name"><input className={'input mono' + (nameBad || nameTaken ? ' invalid' : '')} value={partName} onChange={(e) => { setPartName(e.target.value); if (!slotTouched) setSlotType(e.target.value); }} onKeyDown={(e) => e.stopPropagation()} /></Field>
            <Field label="Slot type" hint="What slot it fits (usually the part name)"><input className="input mono" value={slotType} onChange={(e) => { setSlotType(e.target.value); setSlotTouched(true); }} onKeyDown={(e) => e.stopPropagation()} /></Field>
            <Field label="Display name"><input className="input" value={display} onChange={(e) => setDisplay(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></Field>
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Authors"><input className="input" value={s.modAuthor} placeholder="your name" onChange={(e) => set({ modAuthor: e.target.value })} onKeyDown={(e) => e.stopPropagation()} /></Field>
              <Field label="Value"><input className="input" type="number" style={{ width: 90 }} value={value} onChange={(e) => setValue(+e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></Field>
            </div>
            <Field label="File">
              <select className="select" value={fileKey} onChange={(e) => setFileKey(e.target.value)}>
                <option value="">New file…</option>
                {writableDocs.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
              </select>
            </Field>
            {!fileKey ? (
              <Field label="New file name" hint={homeDoc ? `next to ${homeDoc.name}` : 'open a mod vehicle first'}><input className="input mono" value={newFile} onChange={(e) => setNewFile(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></Field>
            ) : <div />}
            <Field label="Plug into" hint="Adds a slot for it in this part, so it shows up in the vehicle">
              <select className="select" value={plugInto} onChange={(e) => setPlugInto(e.target.value)}>
                <option value="">Nothing (no slot added)</option>
                {writableParts.map((p) => <option key={p.key} value={p.part.name}>{p.part.name}</option>)}
              </select>
            </Field>
          </div>
        ) : (
          <Field label="Part">
            <select className="select" value={existingKey} onChange={(e) => setExistingKey(e.target.value)}>
              {!existing && <option value="">— pick a part —</option>}
              {writableParts.map((p) => <option key={p.key} value={p.key}>{p.part.name} · {p.doc.name}</option>)}
            </select>
          </Field>
        )}
      </div>
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
  ['View', ['view.shading', 'view.hide', 'view.hideOthers', 'view.unhide', 'view.frame', 'view.frameAll', 'view.front', 'view.side', 'view.top', 'view.ortho', 'view.toggleLabels', 'view.toggleMeshes', 'view.isolatePart', 'view.xray']],
  ['Game', ['game.reload']],
  ['App', ['app.newMod', 'app.save', 'app.saveAll', 'app.palette', 'app.quickOpen', 'app.gotoNode', 'app.settings', 'app.toggleEditor', 'app.toggleBottom', 'app.reload']],
];

export const ACTION_LABELS: Record<string, string> = {
  'add.menu': 'Add menu (node, beam, trigger, bulb, wheel…)',
  'game.reload': 'Save all and reload the vehicle in BeamNG',
  'view.shading': 'Cycle flexbody shading (wire / solid / shaded)', 'view.hide': 'Hide selected nodes', 'view.hideOthers': 'Hide everything else', 'view.unhide': 'Unhide all',
  'edit.extrude': 'Extrude nodes (then move)', 'select.grow': 'Grow selection', 'select.shrink': 'Shrink selection', 'edit.merge': 'Merge nodes into the active one',
  'edit.symmetry': 'Toggle X symmetry (mirror twins move too)', 'edit.snapRail': 'Snap slidenodes onto their rail',
  'select.all': 'Select all', 'select.none': 'Select none', 'select.invert': 'Invert selection', 'select.linked': 'Select linked (same part)', 'select.mirror': 'Add mirror twins to selection',
  'transform.grab': 'Move (X/Y/Z lock, type value)', 'transform.scale': 'Scale (S then X then -1 mirrors)', 'transform.rotate': 'Rotate',
  'tool.select': 'Select tool', 'tool.addNode': 'Add node tool', 'tool.beam': 'Beam chain tool', 'tool.tri': 'Triangle tool', 'tool.name': 'Quick naming tool',
  'edit.connect': '2 nodes → beam, 3 → triangle, more → chain', 'edit.flipTri': 'Flip triangle normals', 'edit.delete': 'Delete', 'edit.deleteAlt': 'Delete (alt)', 'edit.rename': 'Rename node (Tab: next)',
  'edit.mirror': 'Mirror to other side', 'edit.duplicate': 'Duplicate & move', 'edit.undo': 'Undo', 'edit.redo': 'Redo', 'edit.redoAlt': 'Redo (alt)',
  'view.frame': 'Frame selection', 'view.frameSelected': 'Frame selection (numpad)', 'view.frameAll': 'Frame all', 'view.front': 'Front view', 'view.back': 'Back view', 'view.side': 'Right view',
  'view.sideOther': 'Left view', 'view.top': 'Top view', 'view.bottom': 'Bottom view', 'view.ortho': 'Toggle ortho', 'view.toggleLabels': 'Toggle all labels',
  'view.toggleMeshes': 'Toggle flexbodies', 'view.isolatePart': 'Isolate part (Shift+H with nothing selected)', 'view.xray': 'X-ray',
  'mode.nodes': 'Pick nodes only', 'mode.beams': 'Pick beams only', 'mode.tris': 'Pick triangles only',
  'app.newMod': 'New mod', 'app.save': 'Save file', 'app.saveAll': 'Save all', 'app.palette': 'Command palette', 'app.quickOpen': 'Go to file', 'app.gotoNode': 'Go to node', 'app.settings': 'Settings',
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
          <div className="shortcut-row"><span>Snap to front / side / top view</span><span className="kbd">{settings().orbitButton === 'middle' ? 'Alt+MMB drag' : 'Alt+RMB drag'}</span></div>
          <div className="shortcut-row"><span>Pan</span><span className="kbd">{settings().orbitButton === 'middle' ? 'Shift+MMB drag' : 'MMB drag'}</span></div>
          <div className="shortcut-row"><span>Context menu</span><span className="kbd">RMB click</span></div>
          <div className="shortcut-row"><span>Zoom</span><span className="kbd">Wheel</span></div>
          <div className="shortcut-row"><span>Slide along rail</span><span className="kbd">G G</span></div>
          <div className="shortcut-row"><span>Increments while moving</span><span className="kbd">hold Alt</span></div>
          <div className="shortcut-row"><span>Select shortest path</span><span className="kbd">Ctrl+click</span></div>
          <div className="shortcut-row"><span>Snap to node / mesh vertex while moving</span><span className="kbd">hold Ctrl</span></div>
          <div className="shortcut-row"><span>Box select</span><span className="kbd">LMB drag</span></div>
          <div className="shortcut-row"><span>Rename node</span><span className="kbd">Double-click</span></div>
          <div className="shortcut-row"><span>Pick meshes / props (always) — plain click picks what Display › Selectable allows</span><span className="kbd">Alt+click</span></div>
          <div className="group-label">Code editor</div>
          <div className="shortcut-row"><span>Add a cursor (rows under every cursor light up in 3D)</span><span className="kbd">Ctrl+click</span></div>
          <div className="shortcut-row"><span>Cursor on the line above / below</span><span className="kbd">Ctrl+Alt+↑ / ↓</span></div>
          <div className="shortcut-row"><span>Column (box) selection</span><span className="kbd">Shift+Alt+drag</span></div>
          <div className="shortcut-row"><span>Go to definition</span><span className="kbd">Alt+click / F12</span></div>
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
