/**
 * Workspace: the open vehicle (or loose files), its documents and the assembled result.
 *
 * Every editable document is backed by a Monaco text model, which is the single source of truth
 * for its text. Tool edits are applied to the model (so Monaco's undo stack records them), and a
 * global history groups multi-file operations for undo from the 3D view.
 */
import { create } from 'zustand';
import { monaco } from '../lib/monaco';
import { api } from '../lib/api';
import { parseJbeamFile } from '@core/jbeam/parts';
import { PartLibrary, assembleLoose, buildVehicle, resolveTree } from '@core/jbeam/assemble';
import { normalizeConfig } from '@core/jbeam/config';
import { parseSjson, toJs, type ANode } from '@core/sjson';
import type { TextEdit } from '@core/jbeam/edit';
import { merge3, mergedText } from '@core/merge';
import type { JFile, PartDef, Vehicle, VehicleConfig } from '@core/jbeam/types';
import type { FileRef, VFile, VehicleInfo } from '@shared/ipc';
import { settings } from '../state/settings';
import { toast } from '../state/toast';
import { useSel, type ViewScope } from '../state/selection';
import { useUi, openTab } from '../state/ui';

export type DocLang = 'jbeam' | 'json' | 'lua' | 'text' | 'csv';

export interface Doc {
  key: string;
  vpath: string;
  name: string;
  ref: FileRef;
  writable: boolean;
  source: string;
  isCommon: boolean;
  lang: DocLang;
  text: string;
  savedText: string;
  jfile?: JFile;
  model?: monaco.editor.ITextModel;
  size: number;
  /** last known modification time on disk */
  mtime?: number;
  /** listed for the explorer only: content never loaded, never reloaded, never saved */
  binary?: boolean;
}

/** Files EditorNG may read and write as text. Everything else is listed but never touched. */
export function isTextPath(p: string): boolean {
  return TEXT_EXT.test(p);
}

export interface ElementRef {
  kind: 'node' | 'beam' | 'tri' | 'wheel' | 'flex' | 'prop' | 'trigger' | 'slot' | 'var';
  idx: number;
}

export interface WsState {
  version: number;
  loading: string | null;
  model: string | null;
  mode: 'vehicle' | 'loose' | 'none';
  vehicle: Vehicle | null;
  docs: Doc[];
  configs: Doc[];
  activeConfig: string; // doc key or ''
  dirtyCount: number;
  target: { doc: string; part: string } | null;
  vehicles: VehicleInfo[];
  canUndo: boolean;
  canRedo: boolean;
  assembleMs: number;
}

export const useWs = create<WsState>(() => ({
  version: 0,
  loading: null,
  model: null,
  mode: 'none',
  vehicle: null,
  docs: [],
  configs: [],
  activeConfig: '',
  dirtyCount: 0,
  target: null,
  vehicles: [],
  canUndo: false,
  canRedo: false,
  assembleMs: 0,
}));

function langOf(name: string): DocLang {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jbeam') return 'jbeam';
  if (ext === 'pc' || ext === 'json') return 'json';
  if (ext === 'lua') return 'lua';
  if (ext === 'csv') return 'csv';
  return 'text';
}

const TEXT_EXT = /\.(jbeam|pc|json|lua|csv|txt|md|ini|cs|sbeam)$/i;

interface HistGroup {
  label: string;
  entries: Array<{ key: string; before: number; after: number }>;
  time: number;
  typing?: boolean;
}

type Listener = () => void;

class Workspace {
  docs = new Map<string, Doc>();
  lib: PartLibrary | null = null;
  vehicle: Vehicle | null = null;
  config: VehicleConfig = {};
  /** user modifications of the slot choices / variables on top of the active .pc */
  configOverride: { parts: Record<string, string>; vars: Record<string, number> } = { parts: {}, vars: {} };
  rowIndex = new Map<ANode, ElementRef[]>();
  /** per document: rows sorted by offset, for cursor -> element lookups */
  rowsByFile = new Map<string, Array<{ node: ANode; refs: ElementRef[] }>>();
  model: string | null = null;
  mode: 'vehicle' | 'loose' | 'none' = 'none';
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private internal = 0;
  private lastAlt = new Map<string, number>();
  private undoStack: HistGroup[] = [];
  private redoStack: HistGroup[] = [];
  private listeners = new Set<Listener>();
  private openToken = 0;
  defaultPc = '';

  onAssembled(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  doc(key: string | undefined | null): Doc | undefined {
    return key ? this.docs.get(key.toLowerCase()) : undefined;
  }

  docForPart(part: PartDef): Doc | undefined {
    return this.doc(part.file);
  }

  // ---------------------------------------------------------------------------------------
  // loading
  // ---------------------------------------------------------------------------------------

  async refreshVehicleList(): Promise<VehicleInfo[]> {
    const list = await api.listVehicles();
    useWs.setState({ vehicles: list });
    return list;
  }

  private reset() {
    for (const d of this.docs.values()) d.model?.dispose();
    this.docs.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.lastAlt.clear();
    this.vehicle = null;
    this.lib = null;
    this.configOverride = { parts: {}, vars: {} };
    this.rowIndex.clear();
  }

  private addDoc(f: VFile | { vpath: string; real: string; size: number }, text: string, isCommon: boolean): Doc {
    const vf = f as VFile;
    const name = f.vpath.slice(f.vpath.lastIndexOf('/') + 1);
    const doc: Doc = {
      key: f.vpath.toLowerCase(),
      vpath: f.vpath,
      name,
      ref: { vpath: f.vpath, mount: vf.mount ?? -1, real: f.real },
      writable: vf.writable ?? !!f.real,
      source: vf.source ?? 'Local file',
      isCommon,
      lang: langOf(name),
      text,
      savedText: text,
      size: f.size,
    };
    if (doc.lang === 'jbeam') doc.jfile = parseJbeamFile(doc.key, text);
    this.docs.set(doc.key, doc);
    return doc;
  }

  async openVehicle(model: string, pc?: string): Promise<void> {
    const token = ++this.openToken;
    useWs.setState({ loading: `Loading ${model}…` });
    try {
      const s = settings();
      const [own, common] = await Promise.all([
        api.listTree('vehicles/' + model),
        s.loadCommonFolder ? api.listTree('vehicles/common') : Promise.resolve([] as VFile[]),
      ]);
      const ownText = own.filter((f) => TEXT_EXT.test(f.vpath) && f.size < 8_000_000);
      const comText = common.filter((f) => /\.jbeam$/i.test(f.vpath));
      const [ownTexts, comTexts] = await Promise.all([api.readTexts(ownText), api.readTexts(comText)]);
      if (token !== this.openToken) return;
      this.reset();
      this.model = model;
      this.mode = 'vehicle';
      ownText.forEach((f, i) => this.addDoc(f, ownTexts[i], false));
      comText.forEach((f, i) => {
        if (!this.docs.has(f.vpath.toLowerCase())) this.addDoc(f, comTexts[i], true);
      });
      // binary/other files are listed too (for the explorer), without content
      for (const f of own) {
        if (!this.docs.has(f.vpath.toLowerCase())) {
          const d = this.addDoc(f, '', false);
          d.lang = 'text';
          d.binary = true;
        }
      }
      meshFiles = [...own, ...common].filter((f) => /\.dae$/i.test(f.vpath));
      const info = this.doc(`vehicles/${model}/info.json`);
      this.defaultPc = '';
      if (info) {
        const j = toJs(parseSjson(info.text).root);
        if (j && typeof j.default_pc === 'string') this.defaultPc = `vehicles/${model}/${j.default_pc}.pc`.toLowerCase();
      }
      let active = '';
      if (pc !== undefined) active = pc.toLowerCase();
      else if (this.defaultPc && this.docs.has(this.defaultPc)) active = this.defaultPc;
      useWs.setState({ activeConfig: active, model, mode: 'vehicle' });
      this.loadConfig();
      this.assemble();
      this.watch();
      const main = this.vehicle?.root?.def.file;
      useUi.setState({ activity: 'structure', structMode: 'files', sidebar: true });
      if (main && this.doc(main)) openTab(main);
      useSel.setState({ scope: main ? { mode: 'file', file: main } : { mode: 'vehicle' }, sel: { nodes: new Set(), beams: new Set(), tris: new Set(), flex: new Set(), props: new Set(), triggers: new Set() } });
    } catch (e: any) {
      toast('error', `Could not open ${model}: ${e?.message ?? e}`);
    } finally {
      if (token === this.openToken) useWs.setState({ loading: null });
    }
  }

  /** Opens arbitrary .jbeam files from disk (loose mode). */
  async openFiles(paths: string[]): Promise<void> {
    const skipped = paths.filter((p) => !isTextPath(p));
    paths = paths.filter((p) => isTextPath(p));
    if (skipped.length) toast('warn', `Not a text file, not opened: ${skipped.map((p) => p.split(/[\\/]/).pop()).join(', ')}`);
    if (!paths.length) return;
    const token = ++this.openToken;
    onFilesOpened?.(paths);
    useWs.setState({ loading: 'Loading files…' });
    try {
      const texts = await Promise.all(paths.map((p) => api.readTextFile(p)));
      const s = settings();
      const common = s.loadCommonFolder ? await api.listTree('vehicles/common') : [];
      const comJ = common.filter((f) => /\.jbeam$/i.test(f.vpath));
      const comTexts = await api.readTexts(comJ);
      if (token !== this.openToken) return;
      this.reset();
      this.mode = 'loose';
      this.model = null;
      paths.forEach((p, i) => {
        const vpath = p.replace(/\\/g, '/');
        this.addDoc({ vpath, real: p, size: texts[i].length }, texts[i], false);
      });
      comJ.forEach((f, i) => {
        if (!this.docs.has(f.vpath.toLowerCase())) this.addDoc(f, comTexts[i], true);
      });
      meshFiles = common.filter((f) => /\.dae$/i.test(f.vpath));
      // also index meshes next to the opened files
      const dirs = [...new Set(paths.map((p) => p.replace(/[\\/][^\\/]*$/, '')))];
      for (const d of dirs) {
        const ents = await api.walkDir(d).catch(() => []);
        for (const e of ents) {
          if (!e.dir && /\.dae$/i.test(e.name)) meshFiles.push({ vpath: e.path.replace(/\\/g, '/'), mount: -1, real: e.path, size: e.size, writable: true, source: 'Local', kind: 'extra' });
        }
      }
      useWs.setState({ activeConfig: '', model: null, mode: 'loose' });
      this.config = {};
      this.assemble();
      this.watch();
    } catch (e: any) {
      toast('error', `Could not open files: ${e?.message ?? e}`);
    } finally {
      if (token === this.openToken) useWs.setState({ loading: null });
    }
  }

  async reloadFromDisk(): Promise<void> {
    if (this.mode === 'vehicle' && this.model) await this.openVehicle(this.model, useWs.getState().activeConfig);
    else if (this.mode === 'loose') await this.openFiles([...this.docs.values()].filter((d) => !d.isCommon && d.ref.real).map((d) => d.ref.real!));
  }

  private watch() {
    if (!settings().watchFiles) {
      api.watch([]);
      return;
    }
    const dirs = new Set<string>();
    for (const d of this.docs.values()) {
      if (d.writable && d.ref.real && !d.isCommon) dirs.add(d.ref.real.replace(/[\\/][^\\/]*$/, ''));
    }
    // collapse nested dirs
    const list = [...dirs].sort();
    const roots: string[] = [];
    for (const d of list) if (!roots.some((r) => d.toLowerCase().startsWith(r.toLowerCase() + '\\') || d.toLowerCase().startsWith(r.toLowerCase() + '/'))) roots.push(d);
    api.watch(roots);
  }

  /**
   * Called when files change on disk outside the editor (VS Code, Blender…). Without unsaved
   * edits the file is reloaded. With unsaved edits, by default (policy "merge") the disk changes
   * and the edits are combined like a git merge: clean merges apply at once (one undo step, the
   * edits stay unsaved), overlapping changes open the merge dialog.
   */
  async onExternalChange(paths: string[]): Promise<ExternalChangeResult> {
    const changed: Doc[] = [];
    const set = new Set(paths.map((p) => p.toLowerCase().replace(/\//g, '\\')));
    for (const d of this.docs.values()) {
      if (d.binary || !isTextPath(d.vpath)) continue;
      if (d.ref.real && set.has(d.ref.real.toLowerCase().replace(/\//g, '\\'))) changed.push(d);
    }
    const out: ExternalChangeResult = { reloaded: [], merged: [], conflicts: [], kept: [] };
    const policy = settings().reloadOnExternalChange;
    if (policy === 'never') return out;
    for (const d of changed) {
      const text = await api.readTextFile(d.ref.real!).catch(() => null);
      if (text === null || text === d.savedText) continue;
      this.flush();
      if (!this.isDirty(d) || policy === 'always') {
        d.savedText = text;
        this.replaceText(d, text, false);
        out.reloaded.push(d.name);
        continue;
      }
      if (text === d.text) {
        // saved elsewhere with the same content: nothing left unsaved
        d.savedText = text;
        this.publish();
        out.reloaded.push(d.name);
        continue;
      }
      if (policy === 'ask') {
        out.kept.push(d.name);
        continue;
      }
      const r = merge3(d.savedText, d.text, text);
      if (r.conflicts === 0) {
        this.applyMerge(d, mergedText(r), text);
        out.merged.push(d.name);
      } else {
        out.conflicts.push(d.name);
        this.mergeQueue.set(d.key, text);
      }
    }
    if (out.conflicts.length) this.nextMerge();
    return out;
  }

  /** Files whose disk change overlaps unsaved edits, waiting for the merge dialog (key -> disk text). */
  private mergeQueue = new Map<string, string>();

  /** Opens the merge dialog for the next file with conflicts. */
  nextMerge() {
    if (useUi.getState().dialog?.kind === 'merge') return;
    for (const [key, theirs] of this.mergeQueue) {
      this.mergeQueue.delete(key);
      const d = this.doc(key);
      if (!d || theirs === d.savedText) continue;
      useUi.setState({ dialog: { kind: 'merge', data: { doc: d.key, base: d.savedText, ours: d.text, theirs } } });
      return;
    }
  }

  /**
   * Puts the merged text in the document (one undo step, cursor kept: only the changed middle is
   * replaced) and records the disk text as the saved state, so the user's own edits stay unsaved.
   */
  applyMerge(d: Doc, merged: string, disk: string) {
    this.flush();
    if (merged !== d.text) {
      const e = minimalEdit(d.text, merged);
      this.applyEdits(`Merge ${d.name} with the changes on disk`, new Map([[d.key, [e]]]));
    }
    d.savedText = disk;
    this.publish();
  }

  // ---------------------------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------------------------

  setActiveConfig(key: string) {
    useWs.setState({ activeConfig: key.toLowerCase() });
    this.configOverride = { parts: {}, vars: {} };
    this.loadConfig();
    this.assemble();
  }

  private loadConfig() {
    const key = useWs.getState().activeConfig;
    const d = this.doc(key);
    this.config = d ? normalizeConfig(toJs(parseSjson(d.text).root)) : {};
  }

  /** Effective config: active .pc + overrides */
  effectiveConfig(): VehicleConfig {
    const base = this.config;
    const ov = this.configOverride;
    if (!Object.keys(ov.parts).length && !Object.keys(ov.vars).length) return base;
    const cfg: VehicleConfig = { ...base, vars: { ...(base.vars ?? {}), ...ov.vars } };
    if (Object.keys(ov.parts).length) {
      const parts = { ...(base.parts ?? flattenTree((base as any).partsTree)) };
      Object.assign(parts, ov.parts);
      cfg.parts = parts;
      delete (cfg as any).partsTree;
    }
    return cfg;
  }

  /**
   * Makes a part visible: if the current configuration does not use it, install it (view only)
   * in the first compatible slot of the active tree. Returns false when no slot accepts it.
   */
  ensurePartActive(name: string): boolean {
    const v = this.vehicle;
    if (!v || this.mode !== 'vehicle') return !!v?.partsByName.has(name);
    if (v.partsByName.has(name)) return true;
    const def = this.lib?.get(name);
    if (!def) return false;
    const walk = (slots: Vehicle['root']['slots']): string | null => {
      for (const sn of slots) {
        if (this.lib!.compatible(sn.def).some((p) => p.name === name)) return sn.id;
        if (sn.part) {
          const r = walk(sn.part.slots);
          if (r) return r;
        }
      }
      return null;
    };
    const slot = v.root ? walk(v.root.slots) : null;
    if (!slot) return false;
    this.setSlotPart(slot, name);
    toast('info', `Showing ${name} in slot "${slot}" (view only — change it in Parts or save a .pc)`, undefined, 4000);
    return !!this.vehicle?.partsByName.has(name);
  }

  /** Scopes the 3D view to a part (installing it if needed). */
  focusPart(name: string): boolean {
    const def = this.vehicle?.partsByName.get(name)?.def ?? this.lib?.get(name);
    if (!def) return false;
    if (!this.ensurePartActive(name)) {
      toast('warn', `${name} fits no slot of the current configuration — pick a config that uses its parent, or open the file alone`);
      return false;
    }
    useSel.setState({ scope: { mode: 'part', part: name, file: def.file } });
    const d = this.doc(def.file);
    if (d?.writable && !d.isCommon) this.setTarget(d.key, name);
    return true;
  }

  setScope(scope: ViewScope) {
    useSel.setState({ scope });
  }

  setSlotPart(slotId: string, part: string) {
    this.configOverride.parts[slotId] = part === '' ? 'none' : part;
    this.assemble();
  }

  setVar(name: string, value: number | undefined) {
    if (value === undefined) delete this.configOverride.vars[name];
    else this.configOverride.vars[name] = value;
    this.assemble();
  }

  /** Serializes the current slot choices + variables as a .pc file content. */
  exportConfig(): string {
    const parts: Record<string, string> = {};
    const walk = (slots: Vehicle['root']['slots']) => {
      for (const sn of slots) {
        parts[sn.id] = sn.chosen;
        if (sn.part) walk(sn.part.slots);
      }
    };
    if (this.vehicle?.root) walk(this.vehicle.root.slots);
    const vars: Record<string, number> = {};
    for (const v of this.vehicle?.variables ?? []) if (v.val !== v.default) vars[v.name] = v.val;
    const out: Record<string, any> = { format: 2, model: this.model ?? undefined, parts, vars };
    if (this.vehicle?.mainPart) out.mainPartName = this.vehicle.mainPart;
    return JSON.stringify(out, null, 2);
  }

  // ---------------------------------------------------------------------------------------
  // assembly
  // ---------------------------------------------------------------------------------------

  assemble() {
    const t0 = performance.now();
    const own: JFile[] = [];
    const common: JFile[] = [];
    for (const d of this.docs.values()) {
      if (!d.jfile) continue;
      (d.isCommon ? common : own).push(d.jfile);
    }
    this.lib = new PartLibrary([own, common]);
    let veh: Vehicle | null = null;
    const cfg = this.effectiveConfig();
    if (this.mode === 'vehicle' || (this.mode === 'loose' && own.some((f) => f.parts.some((p) => p.slotTypes.includes('main'))))) {
      const res = resolveTree(this.lib, cfg);
      if (res.root) veh = buildVehicle(res.parts, cfg, res.issues);
    }
    if (!veh && this.mode !== 'none') {
      const defs: PartDef[] = [];
      for (const f of own) defs.push(...f.parts);
      veh = assembleLoose(defs);
    }
    // parse issues are reported per document
    if (veh) {
      for (const d of this.docs.values()) {
        if (!d.jfile || d.isCommon) continue;
        for (const is of d.jfile.issues) {
          veh.issues.push({ sev: is.sev, msg: is.msg, code: is.code ?? 'syntax', file: d.key, s: is.s, e: is.e });
        }
      }
    }
    this.vehicle = veh;
    this.buildRowIndex();
    const ms = performance.now() - t0;
    this.publish({ assembleMs: ms });
    for (const fn of this.listeners) fn();
  }

  private buildRowIndex() {
    const idx = new Map<ANode, ElementRef[]>();
    const byFile = new Map<string, Array<{ node: ANode; refs: ElementRef[] }>>();
    const add = (row: { src: { node: ANode; file: string } }, r: ElementRef) => {
      const n = row.src.node;
      let l = idx.get(n);
      if (!l) {
        idx.set(n, (l = []));
        let fl = byFile.get(row.src.file);
        if (!fl) byFile.set(row.src.file, (fl = []));
        fl.push({ node: n, refs: l });
      }
      l.push(r);
    };
    const v = this.vehicle;
    if (v) {
      v.nodes.forEach((n, i) => add(n.row, { kind: 'node', idx: i }));
      v.beams.forEach((b, i) => add(b.row, { kind: 'beam', idx: i }));
      v.tris.forEach((t, i) => add(t.row, { kind: 'tri', idx: i }));
      v.wheels.forEach((w, i) => add(w.row, { kind: 'wheel', idx: i }));
      v.flexbodies.forEach((f, i) => add(f.row, { kind: 'flex', idx: i }));
      v.props.forEach((p, i) => add(p.row, { kind: 'prop', idx: i }));
      v.triggers.forEach((r, i) => add(r, { kind: 'trigger', idx: i }));
    }
    for (const l of byFile.values()) l.sort((a, b) => a.node.s - b.node.s);
    this.rowIndex = idx;
    this.rowsByFile = byFile;
  }

  private publish(extra: Partial<WsState> = {}) {
    const docs = [...this.docs.values()];
    let dirty = 0;
    for (const d of docs) if (this.isDirty(d)) dirty++;
    const st = useWs.getState();
    let target = st.target;
    if (target && (!this.doc(target.doc) || !this.doc(target.doc)!.jfile?.parts.some((p) => p.name === target!.part))) target = null;
    useWs.setState({
      version: st.version + 1,
      vehicle: this.vehicle,
      docs,
      configs: docs.filter((d) => /\.pc$/i.test(d.vpath) && !d.isCommon).sort((a, b) => a.name.localeCompare(b.name)),
      dirtyCount: dirty,
      model: this.model,
      mode: this.mode,
      target,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      ...extra,
    });
  }

  isDirty(d: Doc): boolean {
    return !d.binary && d.text !== d.savedText;
  }

  // ---------------------------------------------------------------------------------------
  // text changes
  // ---------------------------------------------------------------------------------------

  ensureModel(d: Doc): monaco.editor.ITextModel {
    if (d.model && !d.model.isDisposed()) return d.model;
    const uri = monaco.Uri.from({ scheme: 'beamng', path: '/' + d.vpath.replace(/^\/+/, '').replace(/:/g, '') });
    const existing = monaco.editor.getModel(uri);
    existing?.dispose();
    const lang = d.lang === 'json' ? 'jbeam' : d.lang === 'csv' ? 'plaintext' : d.lang === 'text' ? (/\.md$/i.test(d.name) ? 'markdown' : /\.ini$/i.test(d.name) ? 'ini' : 'plaintext') : d.lang;
    const model = monaco.editor.createModel(d.text, lang, uri);
    model.setEOL(d.text.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    d.model = model;
    this.lastAlt.set(d.key, model.getAlternativeVersionId());
    model.onDidChangeContent((ev) => {
      // whole node rows deleted by hand: offer to remove their beams / triangles (after reparse)
      const removed = !this.internal ? this.removedNodeRows(d, ev.changes) : [];
      if (removed.length && onTypedNodeDelete) setTimeout(() => onTypedNodeDelete?.(d.key, removed), 0);
      const before = this.lastAlt.get(d.key) ?? 0;
      const after = model.getAlternativeVersionId();
      this.lastAlt.set(d.key, after);
      d.text = model.getValue();
      if (!this.internal) {
        // typing in the editor: coalesce into one history group per burst
        const last = this.undoStack[this.undoStack.length - 1];
        const now = Date.now();
        if (last && last.typing && last.entries.length === 1 && last.entries[0].key === d.key && now - last.time < 1500) {
          last.entries[0].after = after;
          last.time = now;
        } else {
          this.undoStack.push({ label: 'Typing', entries: [{ key: d.key, before, after }], time: now, typing: true });
          if (this.undoStack.length > 300) this.undoStack.shift();
        }
        this.redoStack = [];
        this.schedule(d.key, 180);
      } else {
        this.schedule(d.key, 0);
      }
    });
    return model;
  }

  /**
   * Node names whose whole row lies inside a range removed by these editor changes. Only when the
   * last parse matches the text the changes apply to (nothing pending for this document).
   */
  private removedNodeRows(d: Doc, changes: Array<{ rangeOffset: number; rangeLength: number; text: string }>): string[] {
    const v = this.vehicle;
    if (!v || d.lang !== 'jbeam' || this.pending.has(d.key)) return [];
    const cuts = changes.filter((c) => c.rangeLength > 0);
    if (!cuts.length) return [];
    const out: string[] = [];
    for (const n of v.nodes) {
      if (n.row.src.file !== d.key) continue;
      const r = n.row.src.node;
      if (cuts.some((c) => r.s >= c.rangeOffset && r.e <= c.rangeOffset + c.rangeLength && !c.text.includes(`"${n.name}"`))) out.push(n.name);
    }
    return out;
  }

  /** Merges the last `n` undo groups into one (a follow-up edit that belongs to the previous one). */
  mergeLastUndo(n: number, label: string) {
    if (this.undoStack.length < n || n < 2) return;
    const added = this.undoStack.splice(this.undoStack.length - n);
    const by = new Map<string, HistGroup['entries'][number]>();
    for (const g of added) {
      for (const e of g.entries) {
        const p = by.get(e.key);
        if (p) p.after = e.after;
        else by.set(e.key, { ...e });
      }
    }
    this.undoStack.push({ label, entries: [...by.values()], time: Date.now() });
    this.publish();
  }

  private schedule(key: string, delay: number) {
    this.pending.add(key);
    if (this.timer) clearTimeout(this.timer);
    if (delay === 0) {
      this.timer = null;
      queueMicrotask(() => this.flush());
    } else {
      this.timer = setTimeout(() => this.flush(), delay);
    }
  }

  /** Reparses pending documents and reassembles. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    let configTouched = false;
    for (const key of this.pending) {
      const d = this.docs.get(key);
      if (!d) continue;
      if (d.lang === 'jbeam') d.jfile = parseJbeamFile(d.key, d.text);
      if (key === useWs.getState().activeConfig) configTouched = true;
    }
    this.pending.clear();
    if (configTouched) this.loadConfig();
    this.assemble();
  }

  private replaceText(d: Doc, text: string, record: boolean) {
    const model = this.ensureModel(d);
    this.internal++;
    try {
      // replace only the part that differs, so the cursor and scroll position survive a reload
      const e = minimalEdit(model.getValue(), text);
      const a = model.getPositionAt(e.s), b = model.getPositionAt(e.e);
      model.pushEditOperations([], [{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: e.text }], () => null);
      if (!record) model.pushStackElement();
    } finally {
      this.internal--;
    }
    d.text = model.getValue();
    this.flush();
  }

  /**
   * Applies edits to one or more documents as a single undoable operation.
   * Returns false when a target document is read-only.
   */
  applyEdits(label: string, edits: Map<string, TextEdit[]>): boolean {
    for (const key of edits.keys()) {
      const d = this.doc(key);
      if (!d) return false;
      if (!d.writable) {
        toast('warn', `${d.name} is read-only (${d.source}). Use "Make editable copy" first.`);
        return false;
      }
    }
    const group: HistGroup = { label, entries: [], time: Date.now() };
    this.internal++;
    try {
      for (const [key, list] of edits) {
        if (!list.length) continue;
        const d = this.doc(key)!;
        const model = this.ensureModel(d);
        const before = model.getAlternativeVersionId();
        model.pushStackElement();
        // combine inserts at the same offset (Monaco rejects ambiguous overlapping edits)
        const sorted = [...list].sort((a, b) => a.s - b.s || a.e - b.e);
        const merged: TextEdit[] = [];
        for (const ed of sorted) {
          const last = merged[merged.length - 1];
          if (last && last.s === ed.s && last.e === ed.s && ed.e === ed.s) {
            if (!(ed.text === ',' && last.text.endsWith(','))) last.text += ed.text;
          }
          else if (last && ed.s < last.e) continue;
          else merged.push({ ...ed });
        }
        const ops = merged.map((ed) => {
          const a = model.getPositionAt(ed.s);
          const b = model.getPositionAt(ed.e);
          return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: ed.text };
        });
        model.pushEditOperations([], ops, () => null);
        model.pushStackElement();
        d.text = model.getValue();
        this.pending.add(d.key);
        group.entries.push({ key: d.key, before, after: model.getAlternativeVersionId() });
      }
    } finally {
      this.internal--;
    }
    if (group.entries.length) {
      this.undoStack.push(group);
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
    }
    this.flush();
    return true;
  }

  /** Runs several edit operations as one undo step. */
  group<T>(label: string, fn: () => T): T {
    const n = this.undoStack.length;
    try {
      return fn();
    } finally {
      const added = this.undoStack.splice(n);
      if (added.length > 1) {
        const by = new Map<string, HistGroup['entries'][number]>();
        for (const g of added) {
          for (const e of g.entries) {
            const p = by.get(e.key);
            if (p) p.after = e.after;
            else by.set(e.key, { ...e });
          }
        }
        this.undoStack.push({ label, entries: [...by.values()], time: Date.now() });
      } else this.undoStack.push(...added);
    }
  }

  undo(): string | null {
    const g = this.undoStack.pop();
    if (!g) return null;
    this.internal++;
    try {
      for (const en of g.entries) {
        const m = this.doc(en.key)?.model;
        if (!m) continue;
        let guard = 500;
        while (m.getAlternativeVersionId() !== en.before && guard-- > 0 && m.canUndo()) m.undo();
        this.docs.get(en.key)!.text = m.getValue();
        this.pending.add(en.key);
      }
    } finally {
      this.internal--;
    }
    this.redoStack.push(g);
    this.flush();
    return g.label;
  }

  redo(): string | null {
    const g = this.redoStack.pop();
    if (!g) return null;
    this.internal++;
    try {
      for (const en of g.entries) {
        const m = this.doc(en.key)?.model;
        if (!m) continue;
        let guard = 500;
        while (m.getAlternativeVersionId() !== en.after && guard-- > 0 && m.canRedo()) m.redo();
        this.docs.get(en.key)!.text = m.getValue();
        this.pending.add(en.key);
      }
    } finally {
      this.internal--;
    }
    this.undoStack.push(g);
    this.flush();
    return g.label;
  }

  // ---------------------------------------------------------------------------------------
  // saving
  // ---------------------------------------------------------------------------------------

  async save(key: string): Promise<boolean> {
    this.flush();
    const d = this.doc(key);
    if (!d || !d.writable || !d.ref.real) return false;
    if (d.binary || !isTextPath(d.ref.real)) {
      // never write text into a file EditorNG only lists (textures, meshes, sounds…)
      d.text = d.savedText;
      return false;
    }
    const s = settings();
    try {
      const r = await api.writeTextFile(d.ref.real, d.text, { backup: s.backupOnSave, backupDir: s.backupDir || undefined, keepBackups: s.backupCount });
      d.savedText = d.text;
      d.mtime = r.mtime;
      this.publish();
      return true;
    } catch (e: any) {
      toast('error', `Save failed: ${d.name}: ${e?.message ?? e}`);
      return false;
    }
  }

  async saveAll(): Promise<number> {
    let n = 0;
    for (const d of this.docs.values()) if (this.isDirty(d) && (await this.save(d.key))) n++;
    return n;
  }

  /** Copies a read-only file (game zip) into a writable mod folder and reloads it from there. */
  async makeEditable(key: string, modRoot: string): Promise<boolean> {
    const d = this.doc(key);
    if (!d) return false;
    const dest = modRoot.replace(/[\\/]+$/, '') + '/' + d.vpath;
    await api.copyFromVfs(d.ref, dest);
    const roots = settings().extraRoots;
    // the mod folder must be visible to the VFS; unpacked mods already are
    void roots;
    d.ref = { vpath: d.vpath, mount: -1, real: dest.replace(/\//g, '\\') };
    d.writable = true;
    d.source = modRoot.split(/[\\/]/).pop() ?? 'mod';
    d.isCommon = false;
    if (this.isDirty(d)) await this.save(d.key);
    this.publish();
    this.watch();
    return true;
  }

  async createFile(vpath: string, real: string, text: string, deferWrite = false): Promise<Doc> {
    if (!deferWrite) await api.writeTextFile(real, text);
    const d = this.addDoc({ vpath, real, size: text.length }, text, false);
    d.writable = true;
    // deferred: the file only exists once saved (shows as unsaved until then)
    if (deferWrite) d.savedText = '';
    this.assemble();
    this.watch();
    return d;
  }

  clearTarget() {
    useWs.setState({ target: null });
  }

  setTarget(doc: string, part: string) {
    const t = useWs.getState().target;
    if (t && t.doc === doc && t.part === part) return;
    useWs.setState({ target: { doc, part } });
  }

  // ---------------------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------------------

  partDef(name: string): PartDef | undefined {
    return this.vehicle?.partsByName.get(name)?.def ?? this.lib?.get(name);
  }

  /** Elements built from AST rows overlapping [s, e] in a document. */
  elementsInRange(docKey: string, s: number, e: number): ElementRef[] {
    const rows = this.rowsByFile.get(docKey.toLowerCase());
    if (!rows) return [];
    // binary search for the first row ending after s
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].node.e < s) lo = mid + 1;
      else hi = mid;
    }
    const out: ElementRef[] = [];
    for (let i = Math.max(0, lo - 1); i < rows.length && rows[i].node.s <= e; i++) {
      const n = rows[i].node;
      if (n.e >= s && n.s <= e) out.push(...rows[i].refs);
    }
    return out;
  }
}

export interface ExternalChangeResult {
  /** taken from disk (no unsaved edits, or policy "always") */
  reloaded: string[];
  /** disk changes merged with the unsaved edits */
  merged: string[];
  /** overlapping changes: the merge dialog asks */
  conflicts: string[];
  /** unsaved edits kept, disk change not applied (policy "ask") */
  kept: string[];
}

/** One edit turning `a` into `b`: the differing middle between their common prefix and suffix. */
export function minimalEdit(a: string, b: string): TextEdit {
  let p = 0;
  const n = Math.min(a.length, b.length);
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { s: p, e: a.length - s, text: b.slice(p, b.length - s) };
}

function flattenTree(tree: any): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (n: any) => {
    if (!n || !n.children) return;
    for (const id in n.children) {
      const c = n.children[id];
      if (typeof c.chosenPartName === 'string') out[id] = c.chosenPartName === '' ? 'none' : c.chosenPartName;
      walk(c);
    }
  };
  walk(tree);
  return out;
}

export let meshFiles: VFile[] = [];

/** set by ops: node rows were deleted by typing in the code editor */
let onTypedNodeDelete: ((file: string, names: string[]) => void) | null = null;
export function setOnTypedNodeDelete(fn: (file: string, names: string[]) => void) {
  onTypedNodeDelete = fn;
}

/** set by the UI to record recent files (avoids an import cycle) */
let onFilesOpened: ((paths: string[]) => void) | null = null;
export function setOnFilesOpened(fn: (paths: string[]) => void) {
  onFilesOpened = fn;
}

export const ws = new Workspace();
