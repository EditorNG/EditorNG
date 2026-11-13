import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as dgram from 'node:dgram';
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

  h('readTextFile', async (real: string) => decodeText(await fsp.readFile(real)));
  h('readBinaryFile', async (real: string) => new Uint8Array(await fsp.readFile(real)));
  h('writeTextFile', async (real: string, text: string, opts?: { backup?: boolean; backupDir?: string; keepBackups?: number }) => {
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
    return new Promise<{ ok: boolean; message: string }>((resolve) => {
      const expr = [
        'import bpy, sys',
        `bpy.ops.preferences.addon_install(filepath=r"${src}", overwrite=True)`,
        'bpy.ops.preferences.addon_enable(module="editorng_link")',
        'bpy.ops.wm.save_userpref()',
      ].join('; ');
      execFile(exe, ['-b', '--python-exit-code', '1', '--python-expr', expr], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) resolve({ ok: false, message: String(stderr || stdout || err.message).slice(-800) });
        else resolve({ ok: true, message: 'Add-on installed and enabled. Find it in the 3D viewport sidebar (N) under "EditorNG".' });
      });
    });
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
  win.once('ready-to-show', () => win?.show());
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
