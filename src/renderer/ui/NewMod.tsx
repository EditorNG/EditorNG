/**
 * New mod: one dialog for a new vehicle / prop or new parts for an existing vehicle. It writes the
 * files into mods/unpacked, opens the result and (the first time) guides the user through it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Car, Puzzle, Loader2, X, Plus, Check, AlertTriangle, ChevronDown } from 'lucide-react';
import { Modal } from './Dialogs';
import { api } from '../lib/api';
import { ws, useWs } from '../project/workspace';
import { useSettings, settings } from '../state/settings';
import { useUi, openTab } from '../state/ui';
import { useSel } from '../state/selection';
import { toast } from '../state/toast';
import { getViewport } from '../scene/ViewportPanel';
import { useMeshStatus } from '../scene/meshes';
import { loadModel, clearModelCache, type ModelInfo, type SlotChoice } from '../project/modelCatalog';
import {
  BASE_CONFIG, configInfo, copyPartText, emptyPartText, modNameError, newVehicleFiles, partNameError, partNameFor, partTitleFor, pcText, slug, titleOf,
  vehicleIdError, type NewFile, type VehicleType,
} from '@core/newmod';
import { startGuide, markTipSeen, tipSeen, tipsOn, type GuideStep } from './Guide';
import { startVehicleTutorial, startPartTutorial } from './tutorials';

type Kind = 'vehicle' | 'part';
type CatalogEntry = Awaited<ReturnType<typeof api.vehicleCatalog>>[number];

interface PartPlan {
  slot: SlotChoice;
  /** part to copy, '' = empty part */
  from: string;
  name: string;
  title: string;
  /** user edited the name / title (stop following the mod name) */
  nameEdited?: boolean;
  titleEdited?: boolean;
}

const TYPES: Array<[VehicleType, string]> = [
  ['Car', 'Shows with the cars in the vehicle selector.'],
  ['Truck', 'Shows with the trucks.'],
  ['Trailer', 'Shows with the trailers; can be coupled to a vehicle.'],
  ['Prop', 'Shows under Props: objects to place, push and crash into.'],
];

/** set when the user accepted the guide in the dialog: the editor tour follows the creation */
let tourAfterCreate = false;

export function NewModDialog({ close, data }: { close: () => void; data?: { kind?: Kind; model?: string; guide?: boolean } }) {
  const s = useSettings((x) => x.s);
  const openModel = useWs((x) => x.model);
  const dirty = useWs((x) => x.dirtyCount);
  const [kind, setKind] = useState<Kind>(data?.kind ?? (openModel ? 'part' : 'vehicle'));
  const [author, setAuthor] = useState(s.authorName);
  const [busy, setBusy] = useState(false);

  // vehicle
  const [name, setName] = useState('');
  const [brand, setBrand] = useState('');
  const [vtype, setVtype] = useState<VehicleType>('Prop');
  const [template, setTemplate] = useState<'box' | 'empty'>('box');
  const [idEdit, setIdEdit] = useState<string | null>(null);
  const id = idEdit ?? slug(name);

  // part
  const [model, setModel] = useState(data?.model ?? openModel ?? '');
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [infoErr, setInfoErr] = useState('');
  const [plans, setPlans] = useState<PartPlan[]>([]);
  const [addConfig, setAddConfig] = useState(false);

  // mod
  const [modEdit, setModEdit] = useState<string | null>(null);
  const mod = modEdit ?? (kind === 'vehicle' ? id : '');

  // environment
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [mods, setMods] = useState<string[]>([]);
  const [gameRunning, setGameRunning] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [offer, setOffer] = useState(() => tipsOn() && !tipSeen('newmod.offer'));

  useEffect(() => {
    api.vehicleCatalog().then(setCatalog).catch(() => {});
    api.gameRunning().then(setGameRunning).catch(() => {});
    if (s.userDir) api.listDir(`${s.userDir}\\mods\\unpacked`).then((l) => setMods(l.filter((e) => e.dir).map((e) => e.name))).catch(() => {});
    if (data?.guide) showGuide();
  }, []);

  // the picked vehicle's slots and parts
  useEffect(() => {
    setInfo(null);
    setInfoErr('');
    setPlans([]);
    if (!model) return;
    let live = true;
    loadModel(model).then((m) => live && setInfo(m)).catch((e) => live && setInfoErr(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [model]);

  // part names and titles follow the mod name until edited
  useEffect(() => {
    if (!info) return;
    setPlans((ps) => ps.map((p) => ({
      ...p,
      name: p.nameEdited ? p.name : partNameFor(mod || 'my_mod', p.slot.slotType, info.model),
      title: p.titleEdited ? p.title : partTitleFor(mod || 'my_mod', p.slot.description),
    })));
  }, [mod, info]);

  const modRoot = s.userDir && mod ? `${s.userDir}\\mods\\unpacked\\${mod}` : '';
  const modExists = mods.some((m) => m.toLowerCase() === mod.toLowerCase());
  const catEntry = catalog.find((c) => c.model.toLowerCase() === model.toLowerCase());

  // ------------------------------------------------------------------ files and checks
  const files: NewFile[] = useMemo(() => {
    if (kind === 'vehicle') {
      if (vehicleIdError(id)) return [];
      return newVehicleFiles({ id, name: name.trim() || titleOf(id), brand, type: vtype, author: author.trim() || 'Me', template });
    }
    if (!info) return [];
    const out: NewFile[] = [];
    for (const p of plans) {
      const opt = { name: p.name, title: p.title, author: author.trim() || 'Me', slotType: p.slot.slotType };
      const src = p.from ? info.lib.get(p.from) : undefined;
      const text = src ? copyPartText(info.texts.get(src.file.toLowerCase()) ?? '', src, opt) : emptyPartText(opt);
      out.push({ path: `vehicles/${info.model}/${mod}/${p.name}.jbeam`, text });
    }
    if (addConfig && plans.length) {
      const parts = { ...info.defaultParts };
      for (const p of plans) parts[p.slot.id] = p.name;
      out.push(
        { path: `vehicles/${info.model}/${mod}.pc`, text: pcText(info.model, info.mainPart, parts, info.defaultVars) },
        { path: `vehicles/${info.model}/info_${mod}.json`, text: configInfo(titleOf(mod), info.defaultValue || 10000, 'Custom') },
      );
    }
    return out;
  }, [kind, id, name, brand, vtype, author, template, info, plans, mod, addConfig]);

  // files that exist already: in this mod, or anywhere the game would read them from
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const found: string[] = [];
      for (const f of files) {
        const real = modRoot ? `${modRoot}\\${f.path.replace(/\//g, '\\')}` : '';
        if (real && (await api.stat(real).catch(() => null))) {
          found.push(`${f.path} already exists in ${mod}`);
          continue;
        }
        const other = (await api.findAllFiles(f.path).catch(() => [])).find((x) => !x.real || !modRoot || !x.real.toLowerCase().startsWith(modRoot.toLowerCase()));
        if (other) found.push(`${f.path} would cover the same file from ${other.source}`);
      }
      if (live) setConflicts(found);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [files, modRoot]);

  const idTaken = kind === 'vehicle' ? catalog.find((c) => c.model.toLowerCase() === id.toLowerCase()) : undefined;
  const nameIssues = (p: PartPlan): string | null => {
    const e = partNameError(p.name);
    if (e) return e;
    if (info?.lib.get(p.name)) return `${info.model} already has a part called ${p.name}: yours would replace it`;
    if (plans.filter((x) => x.name === p.name).length > 1) return 'Two new parts have this name';
    return null;
  };
  const modErr = modNameError(mod);
  const reason: string | null = !s.userDir
    ? 'Set the BeamNG user folder first'
    : kind === 'vehicle'
      ? (!name.trim() && !idEdit ? 'Give the vehicle a name' : vehicleIdError(id) ?? (idTaken ? (idTaken.game ? `The game already has a vehicle called ${id}` : `${idTaken.source} already has a vehicle called ${id}`) : null))
      : !model ? 'Pick a vehicle' : !info ? (infoErr || 'Reading the vehicle…') : !plans.length ? 'Pick at least one slot' : plans.map(nameIssues).find(Boolean) ?? null;
  const blocking = reason ?? (modErr ? `Mod name: ${modErr}` : conflicts[0] ?? null);

  // ------------------------------------------------------------------ guide
  function showGuide() {
    setOffer(false);
    markTipSeen('newmod.offer');
    tourAfterCreate = true;
    const steps: GuideStep[] = [
      { target: '[data-guide="nm-kind"]', title: 'What are you making?', text: 'A new vehicle or prop starts from a box you can spawn right away. Parts for a vehicle adds new parts to a car that exists, without replacing anything.' },
      kind === 'vehicle'
        ? { target: '[data-guide="nm-name"]', title: 'Name it', text: 'This is the name in the vehicle selector. The folder name (id) is made from it; you can change it.' }
        : { target: '[data-guide="nm-slots"]', title: 'Pick the slots', text: 'A slot is a place on the car where one part goes: front bumper, hood, engine… Your part will be one more choice in that slot.' },
      kind === 'vehicle'
        ? { target: '[data-guide="nm-start"]', title: 'Box or empty', text: 'Box gives you a spawnable 1 m cube with a mesh: change it step by step. Empty has the parts and nothing else.' }
        : { target: '[data-guide="nm-start"]', title: 'Copy or empty', text: 'A copy starts from the part that is already there: it fits and works at once, and you change what you want. Empty starts from nothing.' },
      { target: '[data-guide="nm-mod"]', title: 'The mod folder', text: 'Everything goes into mods/unpacked/<mod name>, ready to test and later to pack. Reusing a mod name adds to that mod.' },
      { target: '[data-guide="nm-files"]', title: 'What gets written', text: 'These are the files that will be created. Nothing of the game is changed.' },
    ];
    startGuide('newmod.dialog', steps);
  }

  // ------------------------------------------------------------------ create
  const create = async () => {
    if (blocking || busy) return;
    setBusy(true);
    try {
      if (useWs.getState().dirtyCount > 0) await ws.saveAll();
      const isNewFolder = !modExists;
      for (const f of files) {
        const real = `${modRoot}\\${f.path.replace(/\//g, '\\')}`;
        await api.mkdirp(real.slice(0, real.lastIndexOf('\\')));
        await api.writeTextFile(real, f.text);
      }
      useSettings.getState().set({ authorName: author.trim() });
      await api.vfsRescan();
      clearModelCache();
      await ws.refreshVehicleList();
      close();
      if (kind === 'vehicle') await openNewVehicle(id, modRoot);
      else await openNewParts(info!.model, plans, addConfig ? `vehicles/${info!.model}/${mod}.pc` : null, modRoot, mod);
      const n = files.length;
      toast('ok', `Created ${n} file${n > 1 ? 's' : ''} in mods/unpacked/${mod}`, { label: 'Open folder', run: () => api.reveal(modRoot) }, 6000);
      if (gameRunning && isNewFolder) toast('warn', 'Restart BeamNG to use this mod: the game only picks up new mod folders when it starts.', undefined, 9000);
      if (tourAfterCreate) {
        tourAfterCreate = false;
        const made: Made = kind === 'vehicle' ? { kind, id } : { kind, model: info!.model, part: plans[0].name, mod, config: addConfig };
        setTimeout(() => editorTour(made), 600);
      }
    } catch (e: any) {
      toast('error', `Could not create the mod: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------------ ui
  const tree = useMemo(() => fileTree(files.map((f) => f.path).concat(kind === 'vehicle' && template === 'box' && files.length ? [`vehicles/${id}/default.jpg`, `vehicles/${id}/${BASE_CONFIG}.jpg`] : [])), [files, kind, template, id]);

  return (
    <Modal title="New mod" width={660} onClose={close} footer={<>
      <span className={'nm-reason' + (blocking ? '' : ' ok')}>{blocking ?? (dirty ? 'Unsaved changes will be saved first' : '')}</span>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" data-guide="nm-create" disabled={!!blocking || busy} onClick={create}>{busy && <Loader2 size={13} className="spin" />} Create and open</button>
    </>}>
      <div className="nm" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') create(); }}>
        {offer && (
          <div className="nm-offer">
            <span>First mod? EditorNG can walk you through it.</span>
            <div className="grow" />
            <button className="btn small primary" onClick={showGuide}>Show me</button>
            <button className="btn small ghost" onClick={() => { setOffer(false); markTipSeen('newmod.offer'); }}>No thanks</button>
          </div>
        )}
        <div className="nm-kinds" data-guide="nm-kind">
          <button className={'nm-kind' + (kind === 'vehicle' ? ' active' : '')} onClick={() => setKind('vehicle')}>
            <Car size={15} /><span><b>New vehicle or prop</b><small>From a box, ready to spawn</small></span>
          </button>
          <button className={'nm-kind' + (kind === 'part' ? ' active' : '')} onClick={() => setKind('part')}>
            <Puzzle size={15} /><span><b>Parts for a vehicle</b><small>Add-on, replaces nothing</small></span>
          </button>
        </div>

        {kind === 'vehicle' ? (
          <>
            <div className="nm-row">
              <F label="Name" tip="Shown in the vehicle selector." guide="nm-name" grow>
                <input className="input" autoFocus value={name} placeholder="My Box" onChange={(e) => setName(e.target.value)} />
              </F>
              <F label="Vehicle id" tip={'The folder under vehicles/ and the main part\'s name.\nMade from the name; lowercase letters, digits and _.'}>
                <input className="input mono" value={id} placeholder="my_box" onChange={(e) => setIdEdit(e.target.value.toLowerCase())} />
              </F>
            </div>
            {(name || idEdit) && <Status text={vehicleIdError(id) ?? (idTaken ? `${idTaken.game ? 'The game' : idTaken.source} already has "${id}": a new vehicle needs its own id` : null)} ok={`Free id: vehicles/${id}`} />}
            <div className="nm-row">
              <F label="Brand" tip="Optional. Shown before the name in the vehicle selector." grow>
                <input className="input" value={brand} placeholder="optional" onChange={(e) => setBrand(e.target.value)} />
              </F>
              <F label="Type" tip={TYPES.map(([t, d]) => `${t}: ${d}`).join('\n')}>
                <div className="segmented">
                  {TYPES.map(([t, d]) => <button key={t} className={'seg' + (vtype === t ? ' active' : '')} data-tip={d} onClick={() => setVtype(t)}>{t}</button>)}
                </div>
              </F>
            </div>
            <F label="Start from" guide="nm-start" tip={'Box: a 1 m cube with nodes, beams, triangles and a mesh. It spawns and crashes like a real vehicle.\nEmpty: the parts with nothing in them; nothing to spawn until you add nodes.'}>
              <div className="segmented">
                <button className={'seg' + (template === 'box' ? ' active' : '')} onClick={() => setTemplate('box')}>Box, spawns right away</button>
                <button className={'seg' + (template === 'empty' ? ' active' : '')} onClick={() => setTemplate('empty')}>Empty</button>
              </div>
            </F>
          </>
        ) : (
          <>
            <F label="Vehicle" tip="The vehicle your parts are for. Mods are listed first.">
              <VehiclePicker catalog={catalog} value={model} onChange={setModel} />
            </F>
            {infoErr && <Status text={`Could not read ${model}: ${infoErr}`} />}
            <F label="Slots" guide="nm-slots" tip={'A slot is a place on the vehicle for one part (front bumper, hood…).\nEach new part becomes one more choice in its slot.'}>
              <SlotPicker info={info} loading={!!model && !info && !infoErr} picked={plans.map((p) => p.slot.id)}
                onAdd={(sl) => setPlans((ps) => [...ps, {
                  slot: sl, from: sl.current || sl.candidates[0]?.name || '',
                  name: partNameFor(mod || 'my_mod', sl.slotType, info!.model), title: partTitleFor(mod || 'my_mod', sl.description),
                }])}
                onRemove={(sid) => setPlans((ps) => ps.filter((p) => p.slot.id !== sid))} />
            </F>
            {plans.length > 0 && (
              <div className="nm-plans" data-guide="nm-start">
                {plans.map((p, k) => {
                  const upd = (patch: Partial<PartPlan>) => setPlans((ps) => ps.map((x, j) => (j === k ? { ...x, ...patch } : x)));
                  const err = nameIssues(p);
                  return (
                    <div key={p.slot.id} className="nm-plan">
                      <div className="nm-plan-head"><b>{p.slot.description}</b><span className="faint mono small-text">{p.slot.slotType}</span></div>
                      <div className="nm-row">
                        <F label="Start from" tip={'Copy: the part that is there now, under your name. It fits and works at once, with the game\'s meshes until you add yours.\nEmpty: no nodes, beams or meshes.'}>
                          <div className="segmented">
                            <select className={'seg-select' + (p.from ? ' active' : '')} value={p.from} onChange={(e) => upd({ from: e.target.value })} disabled={!p.slot.candidates.length}>
                              {p.slot.candidates.map((c) => <option key={c.name} value={c.name}>Copy of {c.name}</option>)}
                              {!p.slot.candidates.length && <option value="">Nothing to copy</option>}
                            </select>
                            <button className={'seg' + (!p.from ? ' active' : '')} onClick={() => upd({ from: '' })}>Empty part</button>
                          </div>
                        </F>
                      </div>
                      <div className="nm-row">
                        <F label="Part name" tip={'The part\'s id. It must not exist for this vehicle, or yours would replace it for every player.'} grow>
                          <input className="input mono" value={p.name} onChange={(e) => upd({ name: e.target.value, nameEdited: true })} />
                        </F>
                        <F label="Shown as" tip="The name in the game's parts menu." grow>
                          <input className="input" value={p.title} onChange={(e) => upd({ title: e.target.value, titleEdited: true })} />
                        </F>
                      </div>
                      {err && <Status text={err} />}
                    </div>
                  );
                })}
              </div>
            )}
            {plans.length > 0 && (
              <label className="nm-check" data-tip={'Writes a .pc with your parts fitted, so it shows in the game\'s configuration list.\nWithout it, pick your parts in the game\'s parts menu.'}>
                <input type="checkbox" checked={addConfig} onChange={(e) => setAddConfig(e.target.checked)} />
                Also add a configuration with {plans.length > 1 ? 'these parts' : 'this part'} fitted
              </label>
            )}
          </>
        )}

        <div className="nm-row">
          <F label="Mod name" guide="nm-mod" grow tip={'The folder in mods/unpacked, and later the zip\'s name.\nLetters, digits, - and _. Reusing the name of one of your mods adds to it.'}>
            <input className="input mono" list="nm-mods" value={mod} placeholder={kind === 'vehicle' ? 'my_box' : 'rally_bumper'} onChange={(e) => setModEdit(e.target.value)} />
            <datalist id="nm-mods">{mods.map((m) => <option key={m} value={m} />)}</datalist>
          </F>
          <F label="Author" tip="Written as &quot;authors&quot; in the files. Remembered for next time.">
            <input className="input" value={author} placeholder="Your name" onChange={(e) => setAuthor(e.target.value)} />
          </F>
        </div>
        {mod && <Status text={modErr} ok={modExists ? `Adds to your mod ${mod}` : 'Free name, valid for packing'} />}

        {files.length > 0 && (
          <div className="nm-files" data-guide="nm-files">
            <div className="faint small-text">Will write in mods/unpacked</div>
            {tree.map((l, i) => <div key={i} className="mono" style={{ paddingLeft: l.depth * 14 }}>{l.text}</div>)}
            {kind === 'part' && info && <div className="faint small-text">{plans.map((p) => `part ${p.name} · slotType ${p.slot.slotType}`).join('\n')}</div>}
          </div>
        )}
        {conflicts.length > 1 && conflicts.slice(1, 4).map((c) => <Status key={c} text={c} />)}
        {gameRunning && !modExists && mod && <div className="nm-note"><AlertTriangle size={13} /> BeamNG is running: restart it afterwards, it only picks up new mod folders at startup.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------------------------

function F(props: { label: string; tip?: string; guide?: string; grow?: boolean; children: React.ReactNode }) {
  return (
    <div className={'field nm-field' + (props.grow ? ' grow' : '')} data-guide={props.guide}>
      <span className="field-label" data-tip={props.tip} data-tip-pos="bottom-right">{props.label}</span>
      {props.children}
    </div>
  );
}

function Status({ text, ok }: { text: string | null; ok?: string }) {
  if (!text && !ok) return null;
  return <div className={'nm-status ' + (text ? 'bad' : 'ok')}>{text ? <X size={12} /> : <Check size={12} />} {text ?? ok}</div>;
}

function VehiclePicker({ catalog, value, onChange }: { catalog: CatalogEntry[]; value: string; onChange: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cur = catalog.find((c) => c.model.toLowerCase() === value.toLowerCase());
  const list = catalog.filter((c) => !q || `${c.brand} ${c.name} ${c.model}`.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <Dropdown open={open} setOpen={setOpen} label={
      cur ? <span className="ellipsis">{[cur.brand, cur.name].filter(Boolean).join(' ')}<span className="faint"> · {cur.game ? 'game' : cur.source}</span></span> : <span className="faint">{value || 'Pick a vehicle'}</span>
    }>
      <input className="input small" autoFocus placeholder="Search vehicles" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && list[0]) {
          e.stopPropagation();
          onChange(list[0].model);
          setOpen(false);
        }
      }} />
      <div className="nm-list">
        {list.map((c) => (
          <button key={c.model} className={'nm-item' + (c.model === value ? ' active' : '')} onClick={() => { onChange(c.model); setOpen(false); }}>
            <span className="ellipsis grow">{[c.brand, c.name].filter(Boolean).join(' ')}</span>
            <span className="faint mono small-text">{c.model}</span>
            <span className="faint small-text">{c.type}{c.game ? '' : ` · ${c.source}`}</span>
          </button>
        ))}
        {!list.length && <div className="faint nm-empty">{catalog.length ? 'No match' : 'Reading the vehicles…'}</div>}
      </div>
    </Dropdown>
  );
}

function SlotPicker(props: { info: ModelInfo | null; loading: boolean; picked: string[]; onAdd: (s: SlotChoice) => void; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const { info } = props;
  // best matches first: the slot's name itself, then names starting with the search, then the rest
  const ql = q.trim().toLowerCase();
  const rank = (s: SlotChoice) => {
    const d = s.description.toLowerCase();
    return d === ql ? 0 : d.startsWith(ql) ? 1 : d.includes(ql) ? 2 : 3;
  };
  const list = (info?.slots ?? [])
    .filter((s) => !props.picked.includes(s.id) && (!ql || `${s.description} ${s.id} ${s.current}`.toLowerCase().includes(ql)))
    .map((s, i) => ({ s, i, r: ql ? rank(s) : 0 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
  return (
    <div className="nm-chips">
      {props.picked.map((id) => {
        const s = info?.slots.find((x) => x.id === id);
        return (
          <span key={id} className="nm-chip">
            {s?.description ?? id}
            <button className="icon-btn tiny" onClick={() => props.onRemove(id)} aria-label="Remove"><X size={11} /></button>
          </span>
        );
      })}
      <Dropdown open={open} setOpen={setOpen} plain label={<span className="nm-add">{props.loading ? <><Loader2 size={12} className="spin" /> Reading slots…</> : <><Plus size={12} /> add slot</>}</span>} disabled={!info}>
        <input className="input small" autoFocus placeholder="Search slots: bumper, hood, engine…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) {
            e.stopPropagation();
            props.onAdd(list[0]);
            setQ('');
            setOpen(false);
          }
        }} />
        <div className="nm-list">
          {list.slice(0, 150).map((s) => (
            <button key={s.id} className="nm-item" style={{ paddingLeft: 8 + Math.min(s.level, 4) * 10 }} onClick={() => { props.onAdd(s); setQ(''); setOpen(false); }}>
              <span className="ellipsis grow">{s.description}</span>
              <span className="faint mono small-text ellipsis" style={{ maxWidth: 220 }}>{s.current || 'empty'}</span>
            </button>
          ))}
          {!list.length && <div className="faint nm-empty">No match</div>}
        </div>
      </Dropdown>
    </div>
  );
}

function Dropdown(props: { open: boolean; setOpen: (o: boolean) => void; label: React.ReactNode; children: React.ReactNode; plain?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number; listMax: number } | null>(null);
  useEffect(() => {
    if (!props.open) return;
    // floats above the dialog (never cut by it), below the button or above it, whichever has more room
    const measure = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight, vw = window.innerWidth;
      const below = vh - r.bottom - 12, above = r.top - 12;
      const down = below >= 260 || below >= above;
      const width = Math.min(Math.max(r.width, 380), vw - 16);
      const left = Math.min(Math.max(8, r.left), vw - width - 8);
      const room = Math.max(140, (down ? below : above) - 52);
      setPlace(down ? { left, top: r.bottom + 4, width, listMax: Math.min(room, 420) } : { left, bottom: vh - r.top + 4, width, listMax: Math.min(room, 420) });
    };
    measure();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !pop.current?.contains(t)) props.setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.setOpen(false);
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [props.open]);
  return (
    <div className="nm-dd" ref={ref}>
      <button className={props.plain ? 'nm-dd-plain' : 'select nm-dd-btn'} disabled={props.disabled} onClick={() => props.setOpen(!props.open)}>
        {props.label}{!props.plain && <ChevronDown size={13} className="faint" />}
      </button>
      {props.open && place && createPortal(
        <div ref={pop} className="nm-dd-pop" data-own-esc onPointerDown={(e) => e.stopPropagation()}
          style={{ left: place.left, top: place.top, bottom: place.bottom, width: place.width, ['--list-max' as any]: `${place.listMax}px` }}>
          {props.children}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** "a/b/c.x" paths as an indented tree */
function fileTree(paths: string[]): Array<{ depth: number; text: string }> {
  const out: Array<{ depth: number; text: string }> = [];
  const seen = new Set<string>();
  for (const p of [...paths].sort()) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ depth: i, text: parts[i] + (i < parts.length - 1 ? '/' : '') });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// after creation
// ---------------------------------------------------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** waits for the vehicle's meshes, then renders the selector thumbnail(s) */
async function writeThumbnails(paths: string[]) {
  const vp = getViewport();
  if (!vp || !paths.length) return;
  // wait until the meshes are in (a big car's .dae takes a while), then a little longer
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < 60000 && quiet < 4) {
    await wait(250);
    quiet = vp.meshCount() > 0 && useMeshStatus.getState().loading === 0 ? quiet + 1 : 0;
  }
  if (!quiet) return;
  await wait(300);
  const url = vp.thumbnail();
  if (!url) return;
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  for (const p of paths) await api.writeBinaryFile(p, bytes).catch(() => {});
}

async function openNewVehicle(id: string, modRoot: string) {
  await ws.openVehicle(id);
  useSel.setState({ scope: { mode: 'vehicle' } });
  getViewport()?.frameNodes(null);
  const dir = `${modRoot}\\vehicles\\${id}`;
  if (ws.vehicle?.flexbodies.length) await writeThumbnails([`${dir}\\default.jpg`, `${dir}\\${BASE_CONFIG}.jpg`]);
  const main = ws.vehicle?.parts.find((p) => p.def.name === `${id}_body`)?.def.file ?? ws.vehicle?.root?.def.file;
  if (main) openTab(main.toLowerCase());
}

async function openNewParts(model: string, plans: PartPlan[], pc: string | null, modRoot: string, mod: string) {
  await ws.openVehicle(model, pc ?? undefined);
  if (!pc) for (const p of plans) ws.setSlotPart(p.slot.id, p.name);
  useSel.setState({ scope: { mode: 'vehicle' } });
  if (pc) await writeThumbnails([`${modRoot}\\vehicles\\${model}\\${mod}.jpg`]);
  const first = plans[0];
  if (first) {
    ws.focusPart(first.name);
    const def = ws.vehicle?.partsByName.get(first.name)?.def;
    if (def) openTab(def.file.toLowerCase());
    getViewport()?.frameNodes(null);
    if (!pc) toast('info', `${plans.map((p) => p.name).join(', ')} ${plans.length > 1 ? 'are' : 'is'} fitted for this session. F5 shows ${plans.length > 1 ? 'them' : 'it'} in game.`, undefined, 7000);
  }
}

/** what was made, for the tutorial that can follow the tour */
type Made = { kind: 'vehicle'; id: string } | { kind: 'part'; model: string; part: string; mod: string; config: boolean };

/** the short tour of the editor after the first mod; it ends by offering the full tutorial */
function editorTour(made: Made) {
  const kind = made.kind;
  startGuide('newmod.editor', [
    { target: '.sidebar', title: 'Your files', text: "Your mod's files can be edited; the game's files are read-only. Right-click for more." },
    { target: '.viewport-wrap', title: 'The 3D view', text: kind === 'vehicle' ? 'Click a node to select it, G to move it, Shift+A to add one. The code follows every change.' : 'Your part is shown on the car. Click a node to select it, G to move it; the code follows every change.' },
    { target: '.editor-wrap', title: 'The code', text: 'The same part as JBeam. Edit either side, they stay in sync. Right-click → Add… inserts sections for you.' },
    { target: '[aria-label="Save all"]', title: 'Save', text: 'Ctrl+S saves the file, Ctrl+Shift+S everything. Nothing is written until you save.' },
    { target: '[data-guide="reload"]', title: 'Try it in game', text: 'F5 saves and respawns the vehicle in BeamNG with what you have open, starting the game if needed.' },
    { target: '[data-guide="check"]', title: 'Check before sharing', text: 'Finds duplicate beams, loose nodes, typos… Run it before you pack the mod.' },
    {
      title: 'That was the tour', wide: true,
      text: kind === 'vehicle'
        ? `The tutorial goes through your new vehicle: what each file is for and every JBeam section in it (nodes, beams, triangles, the mesh), with a few things to try. About 10 minutes, and you can stop at any step.

Help → Tutorial for the open mod starts it later.`
        : `The tutorial goes through your new part: where it lives, how it fits its slot, its mesh, nodes and beams, and how to try it in the game. About 10 minutes, and you can stop at any step.

Help → Tutorial for the open mod starts it later.`,
      choices: [
        { label: 'No thanks', run: () => {} },
        { label: 'Start the tutorial', primary: true, run: () => (made.kind === 'vehicle' ? startVehicleTutorial(made.id) : startPartTutorial(made.model, made.part, made.mod, made.config)) },
      ],
    },
  ]);
}
