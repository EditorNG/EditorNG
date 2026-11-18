/**
 * Virtual filesystem over a BeamNG installation, mirroring how the game overlays content:
 *
 *   1. user folder            <user>/vehicles/...                 (highest priority)
 *   2. unpacked mods          <user>/mods/unpacked/<mod>/vehicles/...
 *   3. zipped mods            <user>/mods/*.zip, <user>/mods/repo/*.zip
 *   4. game content           <game>/content/vehicles/*.zip       (lowest priority)
 *
 * Pure Node (no Electron imports) so it can be exercised from tests.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import yauzl from 'yauzl';

export type MountKind = 'user' | 'unpacked' | 'modzip' | 'game' | 'extra';

export interface Mount {
  id: number;
  kind: MountKind;
  /** Directory or zip file on disk. */
  root: string;
  isZip: boolean;
  label: string;
}

export interface VFile {
  /** Path inside the game's virtual tree, forward slashes, e.g. vehicles/pickup/pickup.jbeam */
  vpath: string;
  mount: number;
  /** Absolute path on disk for directory mounts. */
  real?: string;
  size: number;
  writable: boolean;
  /** Label of the mount that provides the file. */
  source: string;
  kind: MountKind;
}

export interface VehicleInfo {
  model: string;
  /** Mounts providing files for this vehicle, highest priority first. */
  sources: Array<{ mount: number; kind: MountKind; label: string }>;
  name?: string;
  brand?: string;
}

interface ZipIndex {
  zip: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
  /** lowercased vehicles/<model> names present */
  models: Set<string>;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('zip open failed'));
      else resolve(zip);
    });
  });
}

function indexZip(file: string): Promise<ZipIndex> {
  return openZip(file).then(
    (zip) =>
      new Promise<ZipIndex>((resolve, reject) => {
        const entries = new Map<string, yauzl.Entry>();
        const models = new Set<string>();
        zip.on('entry', (e: yauzl.Entry) => {
          const name = e.fileName.replace(/\\/g, '/');
          if (!name.endsWith('/')) {
            entries.set(name.toLowerCase(), e);
            const m = /^vehicles\/([^/]+)\//i.exec(name);
            if (m) models.add(m[1].toLowerCase());
          }
          zip.readEntry();
        });
        zip.on('end', () => resolve({ zip, entries, models }));
        zip.on('error', reject);
        zip.readEntry();
      }),
  );
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('zip read failed'));
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, rel: string, out: Array<{ rel: string; size: number }>): Promise<void> {
  let ents: fs.Dirent[];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    ents.map(async (ent) => {
      const full = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        await walk(full, r, out);
      } else if (ent.isFile()) {
        let size = 0;
        try {
          size = (await fsp.stat(full)).size;
        } catch {
          /* ignore */
        }
        out.push({ rel: r, size });
      }
    }),
  );
}

export interface VfsOptions {
  gameDir?: string;
  userDir?: string;
  /** Additional mod roots (folders containing a `vehicles` directory), highest priority. */
  extraRoots?: string[];
}

export class Vfs {
  mounts: Mount[] = [];
  private zips = new Map<number, Promise<ZipIndex>>();
  private gameZipByModel = new Map<string, number>();
  private ready: Promise<void> | null = null;

  constructor(public opts: VfsOptions) {}

  init(): Promise<void> {
    if (!this.ready) this.ready = this.scan();
    return this.ready;
  }

  async reset(opts?: VfsOptions): Promise<void> {
    for (const p of this.zips.values()) {
      try {
        (await p).zip.close();
      } catch {
        /* ignore */
      }
    }
    this.zips.clear();
    this.gameZipByModel.clear();
    this.mounts = [];
    if (opts) this.opts = opts;
    this.ready = this.scan();
    await this.ready;
  }

  private add(kind: MountKind, root: string, isZip: boolean, label: string): Mount {
    const m: Mount = { id: this.mounts.length, kind, root, isZip, label };
    this.mounts.push(m);
    return m;
  }

  private async scan(): Promise<void> {
    const { gameDir, userDir, extraRoots } = this.opts;
    for (const r of extraRoots ?? []) {
      if (await exists(r)) this.add('extra', r, false, path.basename(r));
    }
    if (userDir && (await exists(userDir))) {
      this.add('user', userDir, false, 'User folder');
      const unpacked = path.join(userDir, 'mods', 'unpacked');
      try {
        for (const ent of await fsp.readdir(unpacked, { withFileTypes: true })) {
          if (ent.isDirectory()) this.add('unpacked', path.join(unpacked, ent.name), false, ent.name);
          else if (ent.isFile() && ent.name.toLowerCase().endsWith('.zip')) this.add('modzip', path.join(unpacked, ent.name), true, ent.name);
        }
      } catch {
        /* no unpacked mods */
      }
      for (const sub of ['mods', path.join('mods', 'repo')]) {
        try {
          for (const ent of await fsp.readdir(path.join(userDir, sub), { withFileTypes: true })) {
            if (ent.isFile() && ent.name.toLowerCase().endsWith('.zip')) {
              this.add('modzip', path.join(userDir, sub, ent.name), true, ent.name);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (gameDir) {
      const content = path.join(gameDir, 'content', 'vehicles');
      try {
        for (const ent of await fsp.readdir(content, { withFileTypes: true })) {
          if (ent.isFile() && ent.name.toLowerCase().endsWith('.zip')) {
            const m = this.add('game', path.join(content, ent.name), true, 'BeamNG ' + ent.name);
            this.gameZipByModel.set(ent.name.slice(0, -4).toLowerCase(), m.id);
          }
        }
      } catch {
        /* no game dir */
      }
    }
  }

  private zipIndex(m: Mount): Promise<ZipIndex> {
    let p = this.zips.get(m.id);
    if (!p) {
      p = indexZip(m.root);
      this.zips.set(m.id, p);
      p.catch(() => this.zips.delete(m.id));
    }
    return p;
  }

  /** Mounts that may contain files for vehicles/<model>, in priority order. */
  private async mountsForModel(model: string): Promise<Mount[]> {
    const lc = model.toLowerCase();
    const out: Mount[] = [];
    for (const m of this.mounts) {
      if (m.isZip) {
        if (m.kind === 'game') {
          // game zips are named after the vehicle they contain
          if (this.gameZipByModel.get(lc) === m.id) out.push(m);
        } else {
          try {
            const idx = await this.zipIndex(m);
            if (idx.models.has(lc)) out.push(m);
          } catch {
            /* unreadable zip */
          }
        }
      } else if (await exists(path.join(m.root, 'vehicles', model))) {
        out.push(m);
      }
    }
    return out;
  }

  async listVehicles(): Promise<VehicleInfo[]> {
    await this.init();
    const map = new Map<string, VehicleInfo>();
    const push = (model: string, m: Mount) => {
      const key = model.toLowerCase();
      if (key === 'common') return;
      let v = map.get(key);
      if (!v) map.set(key, (v = { model, sources: [] }));
      v.sources.push({ mount: m.id, kind: m.kind, label: m.label });
    };
    for (const m of this.mounts) {
      if (m.isZip) {
        if (m.kind === 'game') {
          push(path.basename(m.root).slice(0, -4), m);
        } else {
          try {
            const idx = await this.zipIndex(m);
            for (const model of idx.models) push(model, m);
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          for (const ent of await fsp.readdir(path.join(m.root, 'vehicles'), { withFileTypes: true })) {
            if (ent.isDirectory()) push(ent.name, m);
          }
        } catch {
          /* ignore */
        }
      }
    }
    return [...map.values()].sort((a, b) => {
      const pa = a.sources[0].kind === 'game' ? 1 : 0;
      const pb = b.sources[0].kind === 'game' ? 1 : 0;
      return pa - pb || a.model.localeCompare(b.model);
    });
  }

  /** All files below a virtual directory, merged across mounts (highest priority wins). */
  async listTree(vdir: string): Promise<VFile[]> {
    await this.init();
    vdir = vdir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const m = /^vehicles\/([^/]+)/i.exec(vdir);
    const mounts = m ? await this.mountsForModel(m[1]) : this.mounts;
    const seen = new Map<string, VFile>();
    for (const mount of mounts) {
      if (mount.isZip) {
        let idx: ZipIndex;
        try {
          idx = await this.zipIndex(mount);
        } catch {
          continue;
        }
        const prefix = vdir.toLowerCase() + '/';
        for (const [lc, e] of idx.entries) {
          if (!lc.startsWith(prefix) || seen.has(lc)) continue;
          seen.set(lc, {
            vpath: e.fileName.replace(/\\/g, '/'), mount: mount.id, size: e.uncompressedSize,
            writable: false, source: mount.label, kind: mount.kind,
          });
        }
      } else {
        const base = path.join(mount.root, vdir);
        const files: Array<{ rel: string; size: number }> = [];
        await walk(base, '', files);
        for (const f of files) {
          const vpath = vdir + '/' + f.rel;
          const lc = vpath.toLowerCase();
          if (seen.has(lc)) continue;
          seen.set(lc, {
            vpath, mount: mount.id, real: path.join(base, f.rel), size: f.size,
            writable: true, source: mount.label, kind: mount.kind,
          });
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.vpath.localeCompare(b.vpath));
  }

  async read(file: Pick<VFile, 'vpath' | 'mount' | 'real'>): Promise<Buffer> {
    if (file.real) return fsp.readFile(file.real);
    const mount = this.mounts[file.mount];
    if (!mount) throw new Error('Unknown mount');
    if (!mount.isZip) return fsp.readFile(path.join(mount.root, file.vpath));
    const idx = await this.zipIndex(mount);
    const e = idx.entries.get(file.vpath.toLowerCase());
    if (!e) throw new Error(`Not found in ${mount.label}: ${file.vpath}`);
    return readZipEntry(idx.zip, e);
  }

  async readMany(files: Array<Pick<VFile, 'vpath' | 'mount' | 'real'>>): Promise<Buffer[]> {
    const out: Buffer[] = new Array(files.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= files.length) return;
        try {
          out[i] = await this.read(files[i]);
        } catch {
          out[i] = Buffer.alloc(0);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  /** Every provider of a virtual path, highest priority first (to compare a copy with the original). */
  async findAll(vpath: string): Promise<VFile[]> {
    await this.init();
    vpath = vpath.replace(/\\/g, '/').replace(/^\/+/, '');
    const m = /^vehicles\/([^/]+)/i.exec(vpath);
    const mounts = m ? await this.mountsForModel(m[1]) : this.mounts;
    const out: VFile[] = [];
    for (const mount of mounts) {
      if (mount.isZip) {
        try {
          const idx = await this.zipIndex(mount);
          const e = idx.entries.get(vpath.toLowerCase());
          if (e) out.push({ vpath: e.fileName, mount: mount.id, size: e.uncompressedSize, writable: false, source: mount.label, kind: mount.kind });
        } catch {
          /* ignore */
        }
      } else {
        const real = path.join(mount.root, vpath);
        const st = await fsp.stat(real).catch(() => null);
        if (st?.isFile()) out.push({ vpath, mount: mount.id, real, size: st.size, writable: true, source: mount.label, kind: mount.kind });
      }
    }
    return out;
  }

  /** Lower-cased paths of every file inside the game's own zips (for override checks). */
  async gameFilePaths(): Promise<Set<string>> {
    await this.init();
    const out = new Set<string>();
    for (const mount of this.mounts) {
      if (!mount.isZip || mount.kind !== 'game') continue;
      try {
        const idx = await this.zipIndex(mount);
        for (const lc of idx.entries.keys()) out.add(lc);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /** Files of the game's own zips whose (lower-case) path matches. */
  async gameFiles(test: (lowerPath: string) => boolean): Promise<VFile[]> {
    await this.init();
    const out: VFile[] = [];
    for (const mount of this.mounts) {
      if (!mount.isZip || mount.kind !== 'game') continue;
      try {
        const idx = await this.zipIndex(mount);
        for (const [lc, e] of idx.entries) if (test(lc)) out.push({ vpath: e.fileName, mount: mount.id, size: e.uncompressedSize, writable: false, source: mount.label, kind: mount.kind });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /** .jbeam files of the game's own zips (vpath + mount) for name collision checks. */
  async gameJbeams(): Promise<VFile[]> {
    await this.init();
    const out: VFile[] = [];
    for (const mount of this.mounts) {
      if (!mount.isZip || mount.kind !== 'game') continue;
      try {
        const idx = await this.zipIndex(mount);
        for (const [lc, e] of idx.entries) if (lc.endsWith('.jbeam')) out.push({ vpath: e.fileName, mount: mount.id, size: e.uncompressedSize, writable: false, source: mount.label, kind: mount.kind });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /** Finds the highest-priority provider of a single virtual path. */
  async find(vpath: string): Promise<VFile | null> {
    await this.init();
    vpath = vpath.replace(/\\/g, '/').replace(/^\/+/, '');
    const m = /^vehicles\/([^/]+)/i.exec(vpath);
    const mounts = m ? await this.mountsForModel(m[1]) : this.mounts;
    for (const mount of mounts) {
      if (mount.isZip) {
        try {
          const idx = await this.zipIndex(mount);
          const e = idx.entries.get(vpath.toLowerCase());
          if (e) return { vpath: e.fileName, mount: mount.id, size: e.uncompressedSize, writable: false, source: mount.label, kind: mount.kind };
        } catch {
          /* ignore */
        }
      } else {
        const real = path.join(mount.root, vpath);
        try {
          const st = await fsp.stat(real);
          if (st.isFile()) return { vpath, mount: mount.id, real, size: st.size, writable: true, source: mount.label, kind: mount.kind };
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }
}

/** Decodes file bytes as text (UTF-8, tolerating a BOM and legacy Latin-1 bytes). */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

/** Locates the BeamNG install and user folder from the launcher's ini file / common locations. */
export async function detectBeamNG(): Promise<{ gameDir?: string; userDir?: string; version?: string }> {
  const out: { gameDir?: string; userDir?: string; version?: string } = {};
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const ini = path.join(local, 'BeamNG', 'BeamNG.drive.ini');
    try {
      const text = await fsp.readFile(ini, 'utf8');
      const ip = /^\s*installPath\s*=\s*(.+?)\s*$/m.exec(text);
      const ver = /^\s*version\s*=\s*(.+?)\s*$/m.exec(text);
      if (ip && (await exists(ip[1]))) out.gameDir = ip[1].replace(/[\\/]+$/, '');
      if (ver) out.version = ver[1];
    } catch {
      /* ignore */
    }
    const cur = path.join(local, 'BeamNG', 'BeamNG.drive', 'current');
    if (await exists(cur)) {
      out.userDir = cur;
    } else {
      // pre-0.36 layout: %LOCALAPPDATA%/BeamNG.drive/<version>
      const old = path.join(local, 'BeamNG.drive');
      try {
        const dirs = (await fsp.readdir(old, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && /^\d+\.\d+/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => parseFloat(b) - parseFloat(a));
        if (dirs.length) out.userDir = path.join(old, dirs[0]);
      } catch {
        /* ignore */
      }
    }
  }
  if (!out.gameDir) {
    const candidates = [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\BeamNG.drive',
      'C:\\Program Files\\Steam\\steamapps\\common\\BeamNG.drive',
      'D:\\SteamLibrary\\steamapps\\common\\BeamNG.drive',
      'E:\\SteamLibrary\\steamapps\\common\\BeamNG.drive',
    ];
    for (const c of candidates) {
      if (await exists(path.join(c, 'content', 'vehicles'))) {
        out.gameDir = c;
        break;
      }
    }
  }
  return out;
}
