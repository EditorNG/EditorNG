/**
 * Pack a mod: pre-release checks (what moderators reject), a smaller download (DDS instead of PNG,
 * leftovers left out), then the zip.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Package, FolderOpen, RotateCw, ChevronDown, ChevronRight, Check, Loader2 } from 'lucide-react';
import { Modal } from './Dialogs';
import { api } from '../lib/api';
import { ws, useWs } from '../project/workspace';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { openMenu } from './Menu';

type Scan = Awaited<ReturnType<typeof api.scanMod>>;
type Issue = Scan['issues'][number];

const SECTIONS: Array<{ cat: Issue['cat']; title: string; blurb: string }> = [
  { cat: 'release', title: 'Must fix', blurb: 'What breaks the mod or other mods, or gets it rejected from the repository.' },
  { cat: 'before', title: 'Before release', blurb: 'What players see in the game: names, previews, configuration cards.' },
  { cat: 'size', title: 'Smaller download', blurb: 'Textures: the game converts *.color/normal/data.png to DDS. Ship the DDS, keep naming the .png in materials.json.' },
  { cat: 'tidy', title: 'Tidy up', blurb: 'Files nothing in the mod uses.' },
];

const mb = (n: number) => (n <= 0 ? '0 MB' : n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ICON = { error: <AlertCircle size={13} className="err-text" />, warning: <AlertTriangle size={13} className="warn-text" />, info: <Info size={13} className="info-text" /> };

/** mods/unpacked/<mod> of the open vehicle, when it lives there */
export function guessModDir(): string | null {
  for (const d of ws.docs.values()) {
    const r = d.ref.real;
    if (!r || d.isCommon) continue;
    const m = /^(.*[\\/]mods[\\/]unpacked[\\/][^\\/]+)[\\/]/i.exec(r);
    if (m) return m[1];
  }
  return null;
}

export function PackModDialog({ close }: { close: () => void }) {
  const s = settings();
  const unpacked = s.userDir ? `${s.userDir}\\mods\\unpacked` : '';
  const [mods, setMods] = useState<string[]>([]);
  const [dir, setDir] = useState<string>(() => guessModDir() ?? '');
  const [scan, setScan] = useState<Scan | null>(null);
  const [busy, setBusy] = useState<'' | 'scan' | 'pack' | 'fix'>('');
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set(['release', 'before', 'size']));

  useEffect(() => {
    if (unpacked) api.listDir(unpacked).then((l) => setMods(l.filter((e) => e.dir && e.name !== 'editorng_bridge').map((e) => e.name).sort())).catch(() => {});
    if (dir) run(dir);
  }, []);

  const run = async (d = dir) => {
    if (!d) return;
    setBusy('scan');
    try {
      const r = await api.scanMod(d);
      setScan(r);
      setLeft(new Set(r.exclude));
    } catch (e: any) {
      toast('error', String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  };

  const by = useMemo(() => {
    const m = new Map<Issue['cat'], Issue[]>();
    for (const i of scan?.issues ?? []) (m.get(i.cat) ?? m.set(i.cat, []).get(i.cat)!).push(i);
    return m;
  }, [scan]);
  const errors = scan?.issues.filter((i) => i.sev === 'error').length ?? 0;
  const before = (by.get('before')?.length ?? 0) + (by.get('release')?.filter((i) => i.sev !== 'error').length ?? 0);
  const leftBytes = scan ? scan.files.filter((f) => left.has(f.rel)).reduce((a, f) => a + f.size, 0) : 0;
  const ddsSaving = (by.get('size') ?? []).filter((i) => i.fix?.kind === 'copyDds').reduce((a, i) => a + (i.saves ?? 0), 0);

  const toggleLeft = (file: string) => {
    const n = new Set(left);
    if (n.has(file)) n.delete(file);
    else n.add(file);
    setLeft(n);
  };

  const copyAllDds = async (list: Issue[]) => {
    setBusy('fix');
    try {
      let n = 0;
      for (const i of list) {
        if (i.fix?.kind !== 'copyDds') continue;
        await api.modCopyDds(i.fix.from, i.fix.to);
        n++;
      }
      toast('ok', `Copied ${n} converted texture${n > 1 ? 's' : ''} into the mod; their PNGs are now left out of the zip`);
    } catch (e: any) {
      toast('error', String(e?.message ?? e));
    } finally {
      setBusy('');
      run();
    }
  };

  const pack = async () => {
    if (!scan) return;
    if (useWs.getState().dirtyCount > 0) await ws.saveAll();
    const base = dir.replace(/[\\/]mods[\\/]unpacked[\\/][^\\/]+$/i, '');
    const out = await api.saveDialog({ title: 'Save the mod zip', defaultPath: `${base}\\${scan.name}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (!out) return;
    setBusy('pack');
    try {
      const r = await api.packMod(dir, out, [...left]);
      toast('ok', `Packed ${r.files} files, ${mb(r.size)}: ${out.split(/[\\/]/).pop()}`, { label: 'Show', run: () => api.reveal(out) }, 6000);
    } catch (e: any) {
      toast('error', String(e?.message ?? e));
    } finally {
      setBusy('');
    }
  };

  const modName = dir.split(/[\\/]/).pop() ?? '';
  return (
    <Modal title="Pack a mod" onClose={close} width={780} footer={<>
      <span className="nm-reason">{scan ? `${scan.name}.zip · ${scan.files.length - left.size} files · ${mb(scan.total - leftBytes)} before compression` : ''}</span>
      <button className="btn" onClick={close}>Close</button>
      <button className={'btn ' + (errors ? 'danger' : 'primary')} disabled={!scan || !!busy} onClick={pack}>
        {busy === 'pack' ? <Loader2 size={13} className="spin" /> : <Package size={13} />} {errors ? `Pack anyway (${errors} to fix)` : 'Pack zip…'}
      </button>
    </>}>
      <div className="pk">
        <div className="pk-head">
          <select className="select grow" value={mods.includes(modName) && dir.toLowerCase().startsWith(unpacked.toLowerCase()) ? modName : ''} onChange={(e) => {
            const d = `${unpacked}\\${e.target.value}`;
            setDir(d);
            run(d);
          }}>
            <option value="">{dir && !mods.includes(modName) ? dir : 'Pick a mod in mods/unpacked'}</option>
            {mods.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn" onClick={async () => {
            const p = await api.pickFolder('Mod folder (mods/unpacked/<mod>)', dir || unpacked || undefined);
            if (p) {
              setDir(p);
              run(p);
            }
          }}><FolderOpen size={13} /> Browse</button>
          <button className="btn" disabled={!dir || !!busy} onClick={() => run()} data-tip="Check again (after fixing things)"><RotateCw size={13} /></button>
        </div>

        {busy === 'scan' && <div className="faint pk-wait"><Loader2 size={13} className="spin" /> Checking… the first time it indexes the game's part and material names.</div>}

        {scan && busy !== 'scan' && (
          <>
            <div className="pk-tiles">
              <div className={'pk-tile' + (errors ? ' bad' : ' ok')}><b>{errors || <Check size={16} />}</b><span>{errors ? 'must fix' : 'nothing blocking'}</span></div>
              <div className={'pk-tile' + (before ? ' warn' : '')}><b>{before}</b><span>before release</span></div>
              <div className="pk-tile"><b>{mb(leftBytes + ddsSaving)}</b><span>{ddsSaving ? 'saved (with the DDS fix)' : 'left out of the zip'}</span></div>
              <div className="pk-tile"><b>{mb(scan.total - leftBytes)}</b><span>to pack, {scan.files.length - left.size} files</span></div>
            </div>
            {!scan.issues.length && <div className="empty-hint">Nothing to fix: ready to pack.</div>}
            {SECTIONS.map(({ cat, title, blurb }) => {
              const list = by.get(cat) ?? [];
              if (!list.length) return null;
              const isOpen = open.has(cat);
              const dds = list.filter((i) => i.fix?.kind === 'copyDds');
              return (
                <div key={cat} className="pk-sec">
                  <button className="pk-sec-head" onClick={() => {
                    const n = new Set(open);
                    if (isOpen) n.delete(cat);
                    else n.add(cat);
                    setOpen(n);
                  }}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <b>{title}</b>
                    <span className="badge">{list.length}</span>
                    <span className="faint small-text ellipsis grow">{blurb}</span>
                  </button>
                  {isOpen && dds.length > 1 && (
                    <div className="pk-bulk">
                      <button className="btn small primary" disabled={!!busy} onClick={() => copyAllDds(dds)}>Use the {dds.length} converted DDS</button>
                      <span className="faint small-text">copies them from the game's temp folder next to the PNGs (saves {mb(ddsSaving)})</span>
                    </div>
                  )}
                  {isOpen && list.map((i, k) => (
                    <div key={k} className={'pk-item' + (i.file && left.has(i.file) ? ' out' : '')} onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(e.clientX, e.clientY, [
                        { label: 'Copy', run: () => navigator.clipboard.writeText(`${i.file ?? ''} ${i.msg}`) },
                        i.file && { label: 'Show in folder', run: () => api.reveal(`${dir}\\${i.file!.replace(/\//g, '\\')}`) },
                      ]);
                    }}>
                      {ICON[i.sev]}
                      <div className="pk-item-text">
                        <span>{i.msg}</span>
                        {i.file && <span className="faint mono small-text ellipsis">{i.file}{i.saves ? ` · ${mb(i.saves)}` : ''}</span>}
                      </div>
                      {i.fix?.kind === 'copyDds' && <button className="btn small" disabled={!!busy} onClick={() => copyAllDds([i])}>Use the DDS</button>}
                      {i.fix?.kind === 'exclude' && i.file && (
                        <label className="pk-toggle" data-tip="Left out of the zip (the file stays in your folder)">
                          <input type="checkbox" checked={left.has(i.file)} onChange={() => toggleLeft(i.file!)} /> leave out
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            <div className="faint small-text">Rules from the game's NOTE_FOR_MODDERS.md: unique names, no replaced game files, only what the mod needs, textures as DDS.</div>
          </>
        )}
      </div>
    </Modal>
  );
}
