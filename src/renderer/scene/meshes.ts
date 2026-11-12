/**
 * Flexbody / prop mesh loading. Mesh names are resolved to .dae files through an index
 * (cached on disk), geometry is parsed in a worker, and results are cached in memory.
 */
import * as THREE from 'three';
import { api } from '../lib/api';
import type { VFile } from '@shared/ipc';
import type { DaeMesh } from '@core/dae';
import { create } from 'zustand';

export const useMeshStatus = create<{ loading: number; missing: string[]; indexed: number; total: number }>(() => ({
  loading: 0,
  missing: [],
  indexed: 0,
  total: 0,
}));

let worker: Worker | null = null;
let msgId = 1;
const waiting = new Map<number, (data: any) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./dae.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const cb = waiting.get(ev.data.id);
      if (cb) {
        waiting.delete(ev.data.id);
        cb(ev.data);
      }
    };
  }
  return worker;
}

function call(msg: any, transfer: Transferable[] = []): Promise<any> {
  return new Promise((resolve) => {
    const id = msgId++;
    waiting.set(id, resolve);
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

function fileKey(f: VFile): string {
  return `${f.source}|${f.vpath}|${f.size}`;
}

class MeshManager {
  /** mesh name (lowercase) -> file */
  private index = new Map<string, VFile>();
  private scanned = new Set<string>();
  private geo = new Map<string, THREE.BufferGeometry | null>();
  private files: VFile[] = [];
  private scanning: Promise<void> | null = null;

  setFiles(files: VFile[]) {
    const sig = files.map(fileKey).join('\n');
    if (sig === this.files.map(fileKey).join('\n')) return;
    this.files = files;
    // vehicle files take priority over common ones: order is already priority order
    this.index.clear();
    this.scanned.clear();
    this.scanning = null;
    useMeshStatus.setState({ indexed: 0, total: files.length, missing: [] });
  }

  private async scanFile(f: VFile): Promise<void> {
    const key = fileKey(f);
    if (this.scanned.has(key)) return;
    this.scanned.add(key);
    const cacheKey = 'daeidx2|' + key;
    let names: string[] | null = null;
    const cached = await api.cacheRead(cacheKey);
    if (cached) {
      try {
        names = JSON.parse(new TextDecoder().decode(cached));
      } catch {
        names = null;
      }
    }
    if (!names) {
      const buf = f.real ? await api.readBinaryFile(f.real) : await api.readBinary(f);
      const res = await call({ type: 'scan', buf: buf.buffer }, [buf.buffer as ArrayBuffer]);
      names = (res.names ?? []) as string[];
      api.cacheWrite(cacheKey, new TextEncoder().encode(JSON.stringify(names)));
    }
    for (const n of names) {
      const k = n.toLowerCase();
      if (!this.index.has(k)) this.index.set(k, f);
    }
    useMeshStatus.setState((s) => ({ indexed: s.indexed + 1 }));
  }

  /** Scans files until all names are found (vehicle files first). */
  private async resolve(names: string[]): Promise<void> {
    const need = () => names.filter((n) => !this.index.has(n.toLowerCase()));
    if (!need().length) return;
    for (const f of this.files) {
      if (this.scanned.has(fileKey(f))) continue;
      await this.scanFile(f);
      if (!need().length) return;
    }
  }

  /** Full index scan in the background (for completion lists). */
  indexAll(): Promise<void> {
    if (!this.scanning) {
      this.scanning = (async () => {
        for (const f of this.files) await this.scanFile(f);
      })();
    }
    return this.scanning;
  }

  knownNames(): string[] {
    return [...this.index.keys()];
  }

  fileOf(name: string): VFile | undefined {
    return this.index.get(name.toLowerCase());
  }

  /** local = geometry relative to the mesh pivot (how props with a global position are placed) */
  get(name: string, local = false): THREE.BufferGeometry | null | undefined {
    return this.geo.get(name.toLowerCase() + (local ? '|local' : ''));
  }

  /** Loads geometry for the given mesh names. Resolves when all are loaded (or known missing). */
  async load(names: string[], local = false): Promise<void> {
    const suffix = local ? '|local' : '';
    const want = [...new Set(names.map((n) => n.trim()).filter((n) => n && !this.geo.has(n.toLowerCase() + suffix)))];
    if (!want.length) return;
    useMeshStatus.setState((s) => ({ loading: s.loading + 1 }));
    try {
      await this.resolve(want);
      const byFile = new Map<VFile, string[]>();
      const missing: string[] = [];
      for (const n of want) {
        const f = this.index.get(n.toLowerCase());
        if (!f) {
          missing.push(n);
          this.geo.set(n.toLowerCase() + suffix, null);
          continue;
        }
        let l = byFile.get(f);
        if (!l) byFile.set(f, (l = []));
        l.push(n);
      }
      for (const [f, list] of byFile) {
        const key = fileKey(f);
        let res = await call({ type: 'build', key, names: list, local });
        if (res.needText) {
          const buf = f.real ? await api.readBinaryFile(f.real) : await api.readBinary(f);
          res = await call({ type: 'build', key, names: list, local, buf: buf.buffer }, [buf.buffer as ArrayBuffer]);
        }
        const got = new Map<string, DaeMesh>();
        for (const m of (res.meshes ?? []) as DaeMesh[]) got.set(m.name.toLowerCase(), m);
        for (const n of list) {
          const m = got.get(n.toLowerCase());
          if (!m) {
            missing.push(n);
            this.geo.set(n.toLowerCase() + suffix, null);
            continue;
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
          g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
          g.computeBoundingBox();
          g.computeBoundingSphere();
          this.geo.set(n.toLowerCase() + suffix, g);
        }
      }
      if (missing.length) useMeshStatus.setState((s) => ({ missing: [...new Set([...s.missing, ...missing])] }));
    } finally {
      useMeshStatus.setState((s) => ({ loading: s.loading - 1 }));
    }
  }

  clearGeometry() {
    for (const g of this.geo.values()) g?.dispose();
    this.geo.clear();
    useMeshStatus.setState({ missing: [] });
  }
}

export const meshes = new MeshManager();
