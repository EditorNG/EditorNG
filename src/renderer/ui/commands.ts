import { ws, useWs } from '../project/workspace';
import { showReferences } from './Tier2';
import { reloadInGame } from './GameLink';
import { useUi, log } from '../state/ui';
import { useSettings, settings, keyFor } from '../state/settings';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { getViewport } from '../scene/ViewportPanel';
import { meshes } from '../scene/meshes';
import { useSel } from '../state/selection';
import { checkForUpdates } from '../state/update';
import { hintOnce } from './Guide';
import { startTutorialForOpenMod } from './tutorials';
import { parseSjson, toJs } from '@core/sjson';
import { normalizeConfig } from '@core/jbeam/config';

export interface Command {
  id: string;
  title: string;
  group: string;
  key?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
}

const hasVehicle = () => !!ws.vehicle;

export const COMMANDS: Command[] = [
  { id: 'file.newMod', title: 'New mod…', group: 'File', key: 'app.newMod', run: () => useUi.setState({ dialog: { kind: 'newMod' } }) },
  {
    id: 'file.openPc', title: 'Open .pc configuration…', group: 'File', run: async () => {
      const p = await api.pickFile({ title: 'Open a configuration', filters: [{ name: 'Configuration', extensions: ['pc'] }], defaultPath: settings().userDir || undefined });
      if (p) await openPcFile(p);
    },
  },
  {
    id: 'file.openFile', title: 'Open .jbeam file(s)…', group: 'File', run: async () => {
      const p = await api.pickFile({ title: 'Open JBeam file', filters: [{ name: 'JBeam', extensions: ['jbeam'] }, { name: 'All files', extensions: ['*'] }], defaultPath: settings().userDir || undefined });
      if (p) await ws.openFiles([p]);
    },
  },
  {
    id: 'file.openFolder', title: 'Open mod / vehicle folder…', group: 'File', run: async () => {
      const dir = await api.pickFolder('Open a mod folder (containing vehicles/<name>) or a vehicle folder', settings().userDir ? settings().userDir + '\\mods\\unpacked' : undefined);
      if (!dir) return;
      await openFolder(dir);
    },
  },
  { id: 'file.close', title: 'Close vehicle', group: 'File', run: () => {
    if (useWs.getState().dirtyCount && !confirm('Close without saving your changes?')) return;
    ws.close();
  }, enabled: () => useWs.getState().mode !== 'none' },
  { id: 'app.save', title: 'Save', group: 'File', key: 'app.save', run: async () => {
    const k = useUi.getState().activeTab;
    if (k && ws.doc(k)?.writable) {
      if (await ws.save(k)) {
        toast('ok', `Saved ${ws.doc(k)!.name}`, undefined, 1200);
        firstSaveHint();
      }
    } else {
      const n = await ws.saveAll();
      toast('ok', n ? `Saved ${n} file(s)` : 'Nothing to save', undefined, 1200);
      if (n) firstSaveHint();
    }
  } },
  { id: 'app.saveAll', title: 'Save all', group: 'File', key: 'app.saveAll', run: async () => {
    const n = await ws.saveAll();
    toast('ok', n ? `Saved ${n} file(s)` : 'Nothing to save', undefined, 1400);
    if (n) firstSaveHint();
  } },
  { id: 'app.reload', title: 'Reload vehicle from disk', group: 'File', key: 'app.reload', run: async () => {
    if (useWs.getState().dirtyCount && !confirm('Discard unsaved changes and reload from disk?')) return;
    meshes.clearGeometry();
    await ws.reloadFromDisk();
  }, enabled: hasVehicle },
  { id: 'config.save', title: 'Save part configuration as .pc…', group: 'File', run: () => saveConfig(), enabled: hasVehicle },
  { id: 'edit.undo', title: 'Undo', group: 'Edit', key: 'edit.undo', run: () => {
    const l = ws.undo();
    if (l) toast('info', `Undo: ${l}`, undefined, 1000);
  } },
  { id: 'edit.redo', title: 'Redo', group: 'Edit', key: 'edit.redo', run: () => {
    const l = ws.redo();
    if (l) toast('info', `Redo: ${l}`, undefined, 1000);
  } },
  { id: 'part.mirror', title: 'Mirror current part to the other side…', group: 'Tools', run: () => {
    const sc = useSel.getState().scope;
    const name = sc.mode === 'part' ? sc.part : useWs.getState().target?.part;
    if (name) useUi.setState({ dialog: { kind: 'mirrorPart', data: name } });
  }, enabled: hasVehicle },
  { id: 'tools.importMesh', title: 'Import from Blender / OBJ…', group: 'Tools', run: () => useUi.setState({ dialog: { kind: 'import' } }) },
  { id: 'tools.blenderAddon', title: 'Install Blender live-link add-on', group: 'Tools', run: () => useUi.setState({ dialog: { kind: 'blenderAddon' } }) },
  { id: 'game.reload', title: 'Reload vehicle in game', group: 'Tools', key: 'game.reload', run: () => reloadInGame(), enabled: hasVehicle },
  { id: 'game.setup', title: 'Set up game link (Reload in game)…', group: 'Tools', run: () => useUi.setState({ dialog: { kind: 'gameLink' } }) },
  { id: 'tools.packMod', title: 'Pack mod (pre-release check + zip)…', group: 'Tools', run: () => useUi.setState({ dialog: { kind: 'packMod' } }) },
  { id: 'tools.refs', title: 'Find references of the selected node', group: 'Tools', run: () => {
    const n = [...useSel.getState().sel.nodes][0];
    if (n) showReferences(n);
  }, enabled: hasVehicle },
  { id: 'tools.gamelog', title: 'Game log', group: 'Tools', run: () => useUi.setState({ bottom: true, bottomTab: 'gamelog' }) },
  { id: 'tools.debug', title: 'Run JBeam checks', group: 'Tools', run: () => useUi.setState({ bottom: true, bottomTab: 'checks' }), enabled: hasVehicle },
  { id: 'tools.mass', title: 'Weight distribution', group: 'Tools', run: () => useUi.setState({ bottom: true, bottomTab: 'mass' }), enabled: hasVehicle },
  { id: 'page.suspension', title: 'Suspension analysis', group: 'View', run: () => useUi.setState({ page: 'suspension' }), enabled: hasVehicle },
  { id: 'app.settings', title: 'Settings', group: 'View', key: 'app.settings', run: () => useUi.setState({ page: 'settings' }) },
  { id: 'page.workbench', title: 'Back to editor', group: 'View', run: () => useUi.setState({ page: 'workbench' }) },
  { id: 'app.toggleEditor', title: 'Toggle code editor', group: 'View', key: 'app.toggleEditor', run: () => useSettings.getState().set({ editorVisible: !settings().editorVisible }) },
  { id: 'app.toggleBottom', title: 'Toggle bottom panel', group: 'View', key: 'app.toggleBottom', run: () => useUi.setState({ bottom: !useUi.getState().bottom }) },
  { id: 'view.sidebar', title: 'Toggle sidebar', group: 'View', key: 'Ctrl+B', run: () => useUi.setState({ sidebar: !useUi.getState().sidebar }) },
  { id: 'view.theme', title: 'Toggle light / dark theme', group: 'View', run: () => useSettings.getState().set({ theme: settings().theme === 'light' ? 'dark' : 'light' }) },
  { id: 'view.frameAll', title: 'Frame vehicle', group: 'View', run: () => getViewport()?.frameNodes(null) },
  { id: 'view.screenshot', title: 'Save viewport screenshot…', group: 'View', run: async () => {
    const vp = getViewport();
    if (!vp) return;
    const p = await api.saveDialog({ title: 'Save screenshot', defaultPath: `${ws.model ?? 'vehicle'}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!p) return;
    const data = vp.screenshot().split(',')[1];
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await api.writeBinaryFile(p, bin);
    toast('ok', 'Screenshot saved');
  } },
  { id: 'app.palette', title: 'Command palette', group: 'Go', key: 'app.palette', run: () => useUi.setState({ palette: 'commands' }) },
  { id: 'app.quickOpen', title: 'Go to file…', group: 'Go', key: 'app.quickOpen', run: () => useUi.setState({ palette: 'files' }) },
  { id: 'app.openVehicle', title: 'Open vehicle…', group: 'File', run: () => { ws.refreshVehicleList(); useUi.setState({ palette: 'vehicles' }); } },
  { id: 'app.gotoNode', title: 'Go to node…', group: 'Go', key: 'app.gotoNode', run: () => useUi.setState({ palette: 'nodes' }), enabled: hasVehicle },
  { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', key: 'F1', run: () => useUi.setState({ dialog: { kind: 'shortcuts' } }) },
  { id: 'help.guide', title: 'Replay the beginner guide', group: 'Help', run: () => {
    useSettings.getState().set({ beginnerTips: true, tipsSeen: [] });
    useUi.setState({ dialog: { kind: 'newMod', data: { guide: true } } });
  } },
  { id: 'help.tutorial', title: 'Tutorial for the open mod', group: 'Help', run: () => {
    if (!startTutorialForOpenMod()) toast('info', 'Open your mod first: the tutorial walks through its files (New mod… makes one).', { label: 'New mod…', run: () => useUi.setState({ dialog: { kind: 'newMod' } }) }, 6000);
  } },
  { id: 'help.checkUpdates', title: 'Check for updates…', group: 'Help', run: () => checkForUpdates(true) },
  { id: 'help.devtools', title: 'Toggle developer tools', group: 'Help', run: () => api.windowAction('devtools') },
  { id: 'help.cacheClear', title: 'Clear mesh index cache', group: 'Help', run: async () => {
    await api.cacheClear();
    meshes.clearGeometry();
    toast('ok', 'Cache cleared');
  } },
];

export function command(id: string) {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) return;
  if (c.enabled && !c.enabled()) return;
  Promise.resolve(c.run()).catch((e) => toast('error', String(e?.message ?? e)));
}

export function commandKey(c: Command): string {
  if (!c.key) return '';
  if (c.key.includes('+') || c.key.length <= 3) return c.key.includes('.') ? keyFor(c.key) : c.key;
  return keyFor(c.key);
}

export async function openFolder(dir: string) {
  const norm = dir.replace(/[\\/]+$/, '');
  const ents = await api.listDir(norm).catch(() => []);
  const s = settings();
  const addRoot = async (root: string) => {
    const roots = [...new Set([root, ...s.extraRoots])];
    useSettings.getState().set({ extraRoots: roots });
    await api.configureRoots({ gameDir: s.gameDir, userDir: s.userDir, extraRoots: roots });
    await ws.refreshVehicleList();
  };
  // <mod>/vehicles/<model>
  const vehDir = ents.find((e) => e.dir && e.name.toLowerCase() === 'vehicles');
  if (vehDir) {
    await addRoot(norm);
    const models = (await api.listDir(vehDir.path)).filter((e) => e.dir && e.name.toLowerCase() !== 'common');
    if (models.length) await ws.openVehicle(models[0].name);
    log(`Opened mod folder ${norm}`);
    return;
  }
  // <mod>/vehicles/<model> picked directly
  const m = /^(.*)[\\/]vehicles[\\/]([^\\/]+)$/i.exec(norm);
  if (m) {
    await addRoot(m[1]);
    await ws.openVehicle(m[2]);
    return;
  }
  // loose folder of jbeam files
  const all = await api.walkDir(norm);
  const jb = all.filter((e) => !e.dir && /\.jbeam$/i.test(e.name)).map((e) => e.path);
  if (!jb.length) {
    toast('warn', 'No .jbeam files in that folder');
    return;
  }
  await ws.openFiles(jb);
}

/** a hint the first time something is saved while a vehicle is open */
function firstSaveHint() {
  if (ws.model) setTimeout(() => hintOnce('firstSave', 'Saved. Press F5 (Reload in game) to see it in BeamNG.'), 1400);
}

/** Opens a .pc: its vehicle with that configuration (also from outside the game folders). */
export async function openPcFile(real: string) {
  let j: any = null;
  try {
    j = toJs(parseSjson(await api.readTextFile(real)).root);
  } catch {
    /* read below */
  }
  const m = /[\\/]vehicles[\\/]([^\\/]+)[\\/]([^\\/]+\.pc)$/i.exec(real);
  const model = (typeof j?.model === 'string' && j.model) || m?.[1];
  if (!model) {
    toast('warn', 'This .pc does not say which vehicle it is for (no "model", not in vehicles/<name>/)');
    return;
  }
  const vpath = `vehicles/${model}/${real.split(/[\\/]/).pop()}`;
  const inVfs = m && m[1].toLowerCase() === model.toLowerCase() && (await api.findAllFiles(vpath).catch(() => [])).some((f) => f.real?.toLowerCase() === real.toLowerCase());
  await ws.openVehicle(model, inVfs ? vpath : undefined);
  if (!inVfs && j) {
    const cfg = normalizeConfig(j);
    for (const [slot, part] of Object.entries(cfg.parts ?? {})) ws.setSlotPart(slot, part);
    for (const [k, v] of Object.entries(cfg.vars ?? {})) ws.setVar(k, v);
    toast('info', `Showing ${real.split(/[\\/]/).pop()} on ${model}`, undefined, 3000);
  }
}

async function saveConfig() {
  const model = ws.model;
  if (!model) return;
  const base = [...ws.docs.values()].find((d) => d.writable && !d.isCommon && d.ref.real)?.ref.real;
  const dir = base ? base.replace(/[\\/]vehicles[\\/].*$/i, `\\vehicles\\${model}`) : undefined;
  const p = await api.saveDialog({ title: 'Save configuration', defaultPath: dir ? dir + '\\custom.pc' : 'custom.pc', filters: [{ name: 'Part config', extensions: ['pc'] }] });
  if (!p) return;
  await api.writeTextFile(p, ws.exportConfig());
  toast('ok', `Saved ${p.split(/[\\/]/).pop()}`);
}
