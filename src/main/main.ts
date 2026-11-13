import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as dgram from 'node:dgram';
import { makeZip } from './zip';
import { assertTextWritable } from './binaryGuard';
import { parseJbeamFile } from '../core/jbeam/parts';
import { Vfs, decodeText, detectBeamNG } from './vfs';
import type { BlenderExtract, DirEntry, EnvInfo, FileRef } from '../shared/ipc';

const isDev = !!process.env.EDITORNG_DEV_URL;
let win: BrowserWindow | null = null;
let vfs: Vfs = new Vfs({});
let detected: { gameDir?: string; userDir?: string; version?: string } = {};
let allowClose = process.env.EDITORNG_AUTOMATION === '1';

// Allow tests to run with an isolated profile
if (process.env.EDITORNG_USERDATA) app.setPath('userData', process.env.EDITORNG_USERDATA);

const userData = () => app.getPath('userData');
const settingsFile = () => path.join(userData(), 'settings.json');
const stateFile = () => path.join(userData(), 'state.json');
const cacheDir = () => path.join(userData(), 'cache');

function resourcePath(...p: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), ...p);
}

async function readJson(file: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function walk(dir: string, out: DirEntry[], depth = 0): Promise<void> {
  if (depth > 12) return;
  let ents: fs.Dirent[];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      out.push({ name: e.name, path: p, dir: true, size: 0 });
      await walk(p, out, depth + 1);
    } else if (e.isFile()) {
      let size = 0;
      try {
        size = (await fsp.stat(p)).size;
      } catch {
        /* ignore */
      }
      out.push({ name: e.name, path: p, dir: false, size });
    }
  }
}

// ------------------------------------------------------------------------------------------
// Blender integration
// ------------------------------------------------------------------------------------------

async function findBlender(): Promise<string[]> {
  const found = new Set<string>();
  const tryAdd = async (p: string) => {
    try {
      await fsp.access(p);
      found.add(p);
    } catch {
      /* ignore */
    }
  };
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  for (const r of roots) {
    const bf = path.join(r, 'Blender Foundation');
    try {
      const dirs = (await fsp.readdir(bf)).sort().reverse();
      for (const d of dirs) await tryAdd(path.join(bf, d, 'blender.exe'));
    } catch {
      /* ignore */
    }
    await tryAdd(path.join(r, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'));
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    await tryAdd(`${drive}:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe`);
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) await tryAdd(path.join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  }
  return [...found];
}

function blenderExtract(exe: string, blendFile: string): Promise<BlenderExtract> {
  return new Promise((resolve) => {
    const out = path.join(app.getPath('temp'), `editorng-blender-${process.pid}-${Date.now()}.json`);
    const script = resourcePath('blender', 'extract_mesh.py');
    execFile(
      exe,
      ['-b', blendFile, '--python-exit-code', '1', '--python', script, '--', out],
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      async (err, stdout, stderr) => {
        try {
          const text = await fsp.readFile(out, 'utf8');
          fsp.unlink(out).catch(() => {});
          resolve(JSON.parse(text));
        } catch {
          resolve({ ok: false, objects: [], error: (err?.message ?? 'Blender produced no output') + '\n' + String(stderr || stdout).slice(-1500) });
        }
      },
    );
  });
}

let linkServer: http.Server | null = null;
function startBlenderLink(port: number): void {
  if (linkServer) {
    linkServer.close();
    linkServer = null;
  }
  if (!port) return;
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ app: 'EditorNG', version: app.getVersion() }));
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        win?.webContents.send('blender:link', data);
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
        }
        res.end('{"ok":true}');
      } catch (e) {
        res.statusCode = 400;
        res.end('{"ok":false}');
      }
    });
  });
  srv.on('error', () => {
    /* port busy: the link is simply unavailable */
  });
  srv.listen(port, '127.0.0.1');
  linkServer = srv;
}

// ------------------------------------------------------------------------------------------
// File watching
// ------------------------------------------------------------------------------------------

const watchers = new Map<string, fs.FSWatcher>();
let pendingChanges = new Set<string>();
let changeTimer: NodeJS.Timeout | null = null;
/** Files we wrote ourselves recently; their change events are ignored. */
const ownWrites = new Map<string, number>();

function setWatch(dirs: string[]): void {
  const want = new Set(dirs.map((d) => path.resolve(d)));
  for (const [d, w] of watchers) {
    if (!want.has(d)) {
      w.close();
      watchers.delete(d);
    }
  }
  for (const d of want) {
    if (watchers.has(d)) continue;
    try {
      const w = fs.watch(d, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const full = path.join(d, file.toString());
        const own = ownWrites.get(full.toLowerCase());
        if (own && Date.now() - own < 1500) return;
        pendingChanges.add(full);
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          const list = [...pendingChanges];
          pendingChanges = new Set();
          win?.webContents.send('fs:change', list);
        }, 250);
      });
      w.on('error', () => watchers.delete(d));
      watchers.set(d, w);
    } catch {
      /* directory vanished */
    }
  }
}

// ------------------------------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------------------------------

function registerIpc(): void {
  const h = (name: string, fn: (...args: any[]) => any) => ipcMain.handle(name, (_e, ...args) => fn(...args));

  h('env', async (): Promise<EnvInfo> => ({
    gameDir: vfs.opts.gameDir,
    userDir: vfs.opts.userDir,
    gameVersion: detected.version,
    appVersion: app.getVersion(),
    automation: process.env.EDITORNG_AUTOMATION === '1',
    userData: userData(),
    platform: process.platform,
    argv: process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-')),
    isPackaged: app.isPackaged,
  }));
  h('settingsLoad', () => readJson(settingsFile()));
  h('settingsSave', (v) => writeJsonAtomic(settingsFile(), v));
  h('stateLoad', () => readJson(stateFile()));
  h('stateSave', (v) => writeJsonAtomic(stateFile(), v));

  h('configureRoots', async (roots: { gameDir?: string; userDir?: string; extraRoots?: string[] }) => {
    const next = {
      gameDir: roots.gameDir || detected.gameDir,
      userDir: roots.userDir || detected.userDir,
      extraRoots: roots.extraRoots ?? [],
    };
    const cur = vfs.opts;
    const same = cur.gameDir === next.gameDir && cur.userDir === next.userDir && JSON.stringify(cur.extraRoots ?? []) === JSON.stringify(next.extraRoots);
    if (!same) await vfs.reset(next);
    else await vfs.init();
    return { gameDir: next.gameDir, userDir: next.userDir };
  });
  h('listVehicles', () => vfs.listVehicles());
  h('listTree', (vdir: string) => vfs.listTree(vdir));
  h('readTexts', async (files: FileRef[]) => (await vfs.readMany(files)).map(decodeText));
  h('readBinary', async (file: FileRef) => new Uint8Array(await vfs.read(file)));
  h('findFile', (vpath: string) => vfs.find(vpath));
  h('findAllFiles', (vpath: string) => vfs.findAll(vpath));
  h('listBackups', async (real: string, backupDir?: string) => {
    const dir = backupDir || path.join(userData(), 'backups');
    const base = path.basename(real);
    const hash = crypto.createHash('sha1').update(path.dirname(real).toLowerCase()).digest('hex').slice(0, 8);
    const sub = path.join(dir, `${path.basename(path.dirname(real))}-${hash}`);
    const names = await fsp.readdir(sub).catch(() => [] as string[]);
    const out: Array<{ path: string; time: number }> = [];
    for (const n of names) {
      if (!n.startsWith(base + '.') || !n.endsWith('.bak')) continue;
      const st = await fsp.stat(path.join(sub, n)).catch(() => null);
      if (st) out.push({ path: path.join(sub, n), time: st.mtimeMs });
    }
    return out.sort((a, b) => b.time - a.time);
  });

  // ---- mod packing: scan for what moderators reject, then zip
  let vanillaParts: Map<string, string> | null = null;
  const vanillaPartNames = async () => {
    if (vanillaParts) return vanillaParts;
    const cacheFile = path.join(userData(), 'cache', `vanilla-parts-${(detected.version ?? 'x').replace(/[^\w.]/g, '_')}.json`);
    const cached = await fsp.readFile(cacheFile, 'utf8').then((t) => JSON.parse(t) as Record<string, string>).catch(() => null);
    if (cached) return (vanillaParts = new Map(Object.entries(cached)));
    const files = await vfs.gameJbeams();
    const bufs = await vfs.readMany(files);
    const map = new Map<string, string>();
    files.forEach((f, i) => {
      try {
        for (const p of parseJbeamFile(f.vpath, decodeText(bufs[i])).parts) if (!map.has(p.name.toLowerCase())) map.set(p.name.toLowerCase(), f.vpath);
      } catch {
        /* unparsable vanilla file */
      }
    });
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(Object.fromEntries(map)));
    return (vanillaParts = map);
  };
  h('scanMod', async (modDir: string) => {
    const files: Array<{ rel: string; size: number }> = [];
    const walkDir = async (dir: string, rel: string) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walkDir(p, r);
        else files.push({ rel: r, size: (await fsp.stat(p)).size });
      }
    };
    await walkDir(modDir, '');
    const gamePaths = await vfs.gameFilePaths();
    const vparts = await vanillaPartNames();
    const issues: Array<{ sev: 'error' | 'warning' | 'info'; msg: string; file?: string }> = [];
    const name = path.basename(modDir);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) issues.push({ sev: 'error', msg: `Mod folder / zip name "${name}" may only use A-Z a-z 0-9 - _` });
    if (/v?\d+(\.\d+)+/i.test(name)) issues.push({ sev: 'warning', msg: 'Leave the version out of the name, so updates replace the old zip' });
    for (const f of files) {
      const lc = f.rel.toLowerCase();
      if (gamePaths.has(lc)) issues.push({ sev: 'error', msg: 'Overrides a game file (give it a unique name or path)', file: f.rel });
      if (/\.(txt|md|log|bak|blend\d*|psd|xcf|tmp|orig)$/i.test(lc) || /(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(lc) || /(^|\/)\.git\//.test(lc)) issues.push({ sev: 'warning', msg: 'Leftover file: remove notes, logs, backups and sources before release', file: f.rel });
      if (/\.png$/i.test(lc) && /(^|\/)vehicles\/[^/]+\/.+/.test(lc) && !/\.(color|normal|data)\.png$/i.test(lc) && !/(^|\/)[^/]*(preview|default|thumb|_icon)[^/]*\.png$/i.test(lc)) {
        issues.push({ sev: 'info', msg: 'Texture not named *.color.png / *.normal.png / *.data.png (the game converts only those to DDS)', file: f.rel });
      }
      if (lc.endsWith('.jbeam')) {
        try {
          const text = decodeText(await fsp.readFile(path.join(modDir, f.rel)));
          for (const p of parseJbeamFile(f.rel, text).parts) {
            const v = vparts.get(p.name.toLowerCase());
            if (v) issues.push({ sev: 'error', msg: `Part "${p.name}" has the same name as a game part (${v}); it replaces it for every player`, file: f.rel });
          }
        } catch {
          issues.push({ sev: 'warning', msg: 'Could not parse this .jbeam', file: f.rel });
        }
      }
    }
    // vehicles: info file and preview image
    const models = new Set(files.map((f) => /^vehicles\/([^/]+)\//i.exec(f.rel)?.[1]).filter((x): x is string => !!x && x.toLowerCase() !== 'common'));
    for (const m of models) {
      const inModel = files.filter((f) => f.rel.toLowerCase().startsWith(`vehicles/${m.toLowerCase()}/`));
      const hasJbeam = inModel.some((f) => f.rel.toLowerCase().endsWith('.jbeam'));
      const isNewVehicle = hasJbeam && !gamePaths.has(`vehicles/${m.toLowerCase()}/info.json`) && ![...gamePaths].some((p) => p.startsWith(`vehicles/${m.toLowerCase()}/`));
      if (isNewVehicle) {
        if (!inModel.some((f) => /\/info[^/]*\.json$/i.test(f.rel))) issues.push({ sev: 'warning', msg: `vehicles/${m}: no info.json (vehicle selector name, brand, type)` });
        if (!inModel.some((f) => /\/default\.(png|jpg|jpeg)$/i.test(f.rel))) issues.push({ sev: 'warning', msg: `vehicles/${m}: no default.png / default.jpg preview` });
      }
    }
    const total = files.reduce((a, f) => a + f.size, 0);
    return { name, files: files.map((f) => f.rel), total, issues };
  });
  h('packMod', async (modDir: string, outZip: string) => {
    const files: Array<{ name: string; data: Buffer; mtime: Date }> = [];
    const walkDir = async (dir: string, rel: string) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walkDir(p, r);
        else {
          const st = await fsp.stat(p);
          files.push({ name: r, data: await fsp.readFile(p), mtime: st.mtime });
        }
      }
    };
    await walkDir(modDir, '');
    const zip = makeZip(files);
    await fsp.writeFile(outZip, zip);
    return { files: files.length, size: zip.length };
  });

  h('readTextFile', async (real: string) => decodeText(await fsp.readFile(real)));
  h('readBinaryFile', async (real: string) => new Uint8Array(await fsp.readFile(real)));
  h('writeTextFile', async (real: string, text: string, opts?: { backup?: boolean; backupDir?: string; keepBackups?: number }) => {
    await assertTextWritable(real);
    if (opts?.backup) {
      try {
        const prev = await fsp.readFile(real);
        const dir = opts.backupDir || path.join(userData(), 'backups');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const base = path.basename(real);
        const hash = crypto.createHash('sha1').update(path.dirname(real).toLowerCase()).digest('hex').slice(0, 8);
        const sub = path.join(dir, `${path.basename(path.dirname(real))}-${hash}`);
        await fsp.mkdir(sub, { recursive: true });
        await fsp.writeFile(path.join(sub, `${base}.${stamp}.bak`), prev);
        const keep = opts.keepBackups ?? 20;
        const all = (await fsp.readdir(sub)).filter((f) => f.startsWith(base + '.') && f.endsWith('.bak')).sort();
        for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.unlink(path.join(sub, old)).catch(() => {});
      } catch {
        /* new file: nothing to back up */
      }
    }
    ownWrites.set(real.toLowerCase(), Date.now());
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, text, 'utf8');
    return { mtime: (await fsp.stat(real)).mtimeMs };
  });
  h('writeBinaryFile', async (real: string, data: Uint8Array) => {
    ownWrites.set(real.toLowerCase(), Date.now());
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, Buffer.from(data));
  });
  h('stat', async (real: string) => {
    try {
      const st = await fsp.stat(real);
      return { mtime: st.mtimeMs, size: st.size, dir: st.isDirectory() };
    } catch {
      return null;
    }
  });
  h('listDir', async (real: string): Promise<DirEntry[]> => {
    const ents = await fsp.readdir(real, { withFileTypes: true });
    return ents.map((e) => ({ name: e.name, path: path.join(real, e.name), dir: e.isDirectory(), size: 0 }));
  });
  h('walkDir', async (real: string) => {
    const out: DirEntry[] = [];
    await walk(real, out);
    return out;
  });
  h('mkdirp', (real: string) => fsp.mkdir(real, { recursive: true }).then(() => undefined));
  h('copyFromVfs', async (file: FileRef, dest: string) => {
    const buf = await vfs.read(file);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
  });

  h('pickFolder', async (title?: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { title, defaultPath, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('pickFile', async (o: any) => {
    const r = await dialog.showOpenDialog(win!, { title: o?.title, defaultPath: o?.defaultPath, filters: o?.filters, properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('saveDialog', async (o: any) => {
    const r = await dialog.showSaveDialog(win!, { title: o?.title, defaultPath: o?.defaultPath, filters: o?.filters });
    return r.canceled ? null : r.filePath;
  });
  h('reveal', (real: string) => shell.showItemInFolder(real));
  h('openExternal', async (target: string) => {
    if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
    else await shell.openPath(target);
  });

  const cacheFile = (key: string) => path.join(cacheDir(), crypto.createHash('sha1').update(key).digest('hex') + '.bin');
  h('cacheRead', async (key: string) => {
    try {
      return new Uint8Array(await fsp.readFile(cacheFile(key)));
    } catch {
      return null;
    }
  });
  h('cacheWrite', async (key: string, data: Uint8Array) => {
    await fsp.mkdir(cacheDir(), { recursive: true });
    await fsp.writeFile(cacheFile(key), data);
  });
  h('cacheClear', () => fsp.rm(cacheDir(), { recursive: true, force: true }));

  h('blenderFind', findBlender);
  h('blenderExtract', blenderExtract);
  h('installBlenderAddon', async (exe: string) => {
    const src = resourcePath('blender', 'editorng_link.py');
    const run = (args: string[]) =>
      new Promise<{ err: Error | null; out: string }>((resolve) =>
        execFile(exe, args, { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: String(stdout) + String(stderr) })),
      );
    const expr = [
      'import bpy',
      `bpy.ops.preferences.addon_install(filepath=r"${src}", overwrite=True)`,
      'bpy.ops.preferences.addon_enable(module="editorng_link")',
      'bpy.ops.wm.save_userpref()',
      'print("ENG_SCRIPTS=" + bpy.utils.user_resource("SCRIPTS"))',
    ].join('; ');
    const r = await run(['-b', '--python-exit-code', '1', '--python-expr', expr]);
    if (r.err) return { ok: false, message: r.out.slice(-800) || r.err.message };
    // An open Blender writes its own preferences when it quits, which can undo the "enabled" flag
    // saved above. A one-shot startup script enables the add-on at the next start, then removes itself.
    const m = /ENG_SCRIPTS=(.+)/.exec(r.out);
    if (m) {
      const startup = path.join(m[1].trim(), 'startup');
      await fsp.mkdir(startup, { recursive: true });
      await fsp.writeFile(
        path.join(startup, 'editorng_enable_link.py'),
        [
          '# Written by EditorNG: enables the "EditorNG Link" add-on once, then deletes itself.',
          'import os',
          'import bpy',
          'import addon_utils',
          '',
          'def _enable():',
          '    try:',
          '        addon_utils.enable("editorng_link", default_set=True, persistent=True)',
          '        bpy.ops.wm.save_userpref()',
          '    except Exception as e:',
          '        print("EditorNG: could not enable editorng_link:", e)',
          '    try:',
          '        os.remove(__file__)',
          '    except Exception:',
          '        pass',
          '    return None',
          '',
          'def register():',
          '    bpy.app.timers.register(_enable, first_interval=0.5)',
          '',
          'def unregister():',
          '    pass',
          '',
        ].join('\n'),
        'utf8',
      );
    }
    const open = await new Promise<boolean>((resolve) =>
      execFile('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/NH'], { windowsHide: true }, (_e, out) => resolve(/blender.exe/i.test(String(out)))),
    );
    return {
      ok: true,
      message: open
        ? 'Add-on installed. Blender is open: restart it once and the add-on enables itself (or enable "EditorNG Link" in Edit → Preferences → Add-ons now). Then find it in the 3D viewport sidebar (N) under "EditorNG".'
        : 'Add-on installed and enabled. Find it in the 3D viewport sidebar (N) under "EditorNG".',
    };
  });

  h('watch', (dirs: string[]) => setWatch(dirs));
  h('blenderLinkPort', (port: number) => startBlenderLink(port));

  // ---- game bridge (reload / spawn in the running game) and game log
  const BRIDGE_PORT = 46791;
  let gameSeq = 1;
  h('gameSend', (cmd: Record<string, unknown>, timeoutMs = 700) =>
    new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const id = gameSeq++;
      let done = false;
      const finish = (v: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch {}
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      sock.on('message', (msg) => {
        try {
          const r = JSON.parse(msg.toString('utf8'));
          if (r && (r.id === undefined || r.id === id)) finish(r);
        } catch {}
      });
      sock.on('error', () => finish(null));
      sock.send(JSON.stringify({ ...cmd, id }), BRIDGE_PORT, '127.0.0.1', (err) => err && finish(null));
    }));
  const bridgeDir = () => (vfs.opts.userDir ? path.join(vfs.opts.userDir, 'mods', 'unpacked', 'editorng_bridge') : null);
  const bridgeFiles = ['lua/ge/extensions/editorng/bridge.lua', 'scripts/editorng_bridge/modScript.lua'];
  h('gameBridgeStatus', async () => {
    const dir = bridgeDir();
    if (!dir) return { installed: false, dir: null, files: bridgeFiles };
    const ok = await Promise.all(bridgeFiles.map((f) => fsp.stat(path.join(dir, f)).then(() => true, () => false)));
    return { installed: ok.every(Boolean), dir, files: bridgeFiles };
  });
  h('gameBridgeInstall', async () => {
    const dir = bridgeDir();
    if (!dir) throw new Error('BeamNG user folder not found (Settings → Paths)');
    for (const f of bridgeFiles) {
      const dst = path.join(dir, f);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(resourcePath('game', 'editorng_bridge', f), dst);
    }
    return { dir, files: bridgeFiles };
  });
  h('gameLogRead', async (offset: number) => {
    const file = vfs.opts.userDir ? path.join(vfs.opts.userDir, 'beamng.log') : null;
    if (!file) return { text: '', size: 0, path: null, reset: false };
    const st = await fsp.stat(file).catch(() => null);
    if (!st) return { text: '', size: 0, path: file, reset: false };
    let from = offset;
    let reset = false;
    if (st.size < offset) {
      from = 0;
      reset = true;
    }
    from = Math.max(from, st.size - 1024 * 1024);
    if (st.size <= from) return { text: '', size: st.size, path: file, reset };
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      await fh.read(buf, 0, buf.length, from);
      return { text: buf.toString('utf8'), size: st.size, path: file, reset: reset || from > offset };
    } finally {
      await fh.close();
    }
  });

  h('windowAction', (action: string) => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    else if (action === 'devtools') win.webContents.toggleDevTools();
    else if (action === 'reload') win.webContents.reload();
    else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  });
  h('setTitleBarColors', (c: { color: string; symbolColor: string }) => {
    try {
      win?.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: 36 });
      win?.setBackgroundColor(c.color);
    } catch {
      /* not supported on this platform */
    }
  });
  ipcMain.on('confirmClose', (_e, ok: boolean) => {
    if (ok) {
      allowClose = true;
      win?.close();
    }
  });
}

async function createWindow(): Promise<void> {
  const state = await readJson(stateFile());
  const b = state.windowBounds ?? {};
  win = new BrowserWindow({
    width: b.width ?? 1600,
    height: b.height ?? 960,
    x: b.x,
    y: b.y,
    minWidth: 980,
    minHeight: 600,
    show: false,
    backgroundColor: '#15171a',
    title: 'EditorNG',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1d2024', symbolColor: '#8a919b', height: 36 },
    icon: resourcePath('build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (state.maximized && !process.env.EDITORNG_NO_MAXIMIZE) win.maximize();
  // automated tests run headless: the window lives far off-screen, without focus or a taskbar entry, so it
  // never pops up. It is still "shown" — a never-shown window gets almost no frames (3/s), so the 3D view
  // would not behave like the real thing.
  const headless = process.env.EDITORNG_HEADLESS === '1';
  if (headless) {
    win.setSkipTaskbar(true);
    win.setFocusable(false);
    win.once('ready-to-show', () => {
      if (!win) return;
      win.setPosition(-30000, -30000);
      win.showInactive();
    });
  } else win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (!win) return;
    if (!allowClose) {
      e.preventDefault();
      // persist bounds, then let the renderer decide (unsaved changes)
      const bounds = win.getNormalBounds();
      readJson(stateFile())
        .then((s) => writeJsonAtomic(stateFile(), { ...s, windowBounds: bounds, maximized: win?.isMaximized() }))
        .catch(() => {})
        .finally(() => win?.webContents.send('close-request'));
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev) await win.loadURL(process.env.EDITORNG_DEV_URL!);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  detected = await detectBeamNG();
  vfs = new Vfs({ gameDir: detected.gameDir, userDir: detected.userDir });
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  for (const w of watchers.values()) w.close();
  linkServer?.close();
  app.quit();
});
