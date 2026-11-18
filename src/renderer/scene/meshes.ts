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
    this.inflight.clear();
    this.scanning = null;
    useMeshStatus.setState({ indexed: 0, total: files.length, missing: [] });
  }

  private inflight = new Map<string, Promise<void>>();

  /** Reads a file's mesh names once; concurrent callers share the same scan. */
  private scanFile(f: VFile): Promise<void> {
    const key = fileKey(f);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.doScan(f);
      this.inflight.set(key, p);
    }
    return p;
  }

  private async doScan(f: VFile): Promise<void> {
    const key = fileKey(f);
    if (this.scanned.has(key)) return;
    this.scanned.add(key);
    // v3: names (for lookups) + meshes (objects with geometry, for pick lists)
    const cacheKey = 'daeidx3|' + key;
    let scan: { names: string[]; meshes: string[] } | null = null;
    const cached = await api.cacheRead(cacheKey);
    if (cached) {
      try {
        const j = JSON.parse(new TextDecoder().decode(cached));
        if (Array.isArray(j?.names) && Array.isArray(j?.meshes)) scan = j;
      } catch {
        scan = null;
      }
    }
    if (!scan) {
      const buf = f.real ? await api.readBinaryFile(f.real) : await api.readBinary(f);
      const res = await call({ type: 'scan', buf: buf.buffer }, [buf.buffer as ArrayBuffer]);
      scan = { names: (res.names ?? []) as string[], meshes: (res.meshes ?? res.names ?? []) as string[] };
      api.cacheWrite(cacheKey, new TextEncoder().encode(JSON.stringify(scan)));
    }
    for (const n of scan.names) {
      const k = n.toLowerCase();
      if (!this.index.has(k)) this.index.set(k, f);
    }
    this.byFile.set(key, scan.meshes);
    useMeshStatus.setState((s) => ({ indexed: s.indexed + 1 }));
  }

  /** pickable mesh names (objects with geometry) per file key, files scanned so far */
  private byFile = new Map<string, string[]>();

  /** The mesh names inside each of these files (scans them if needed), in file order. */
  async meshesIn(files: VFile[], onProgress?: (done: number, total: number) => void): Promise<Array<{ file: VFile; names: string[] }>> {
    const out: Array<{ file: VFile; names: string[] }> = [];
    let done = 0;
    for (const f of files) {
      await this.scanFile(f);
      out.push({ file: f, names: this.byFile.get(fileKey(f)) ?? [] });
      onProgress?.(++done, files.length);
    }
    return out;
  }

  /** The .dae files the mesh index knows (vehicle first, then common). */
  allFiles(): VFile[] {
    return this.files;
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
          if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
          // second UV set for layered materials (liveries); the first set stands in when there is none
          // the texture sets under names of our own for the layer shader (liveries). A mesh without a
          // second set gets no layer at all, as in the game (lhas1 = 0)
          if (m.uv) g.setAttribute('luv0', g.getAttribute('uv'));
          // three's second texture set, for maps the material reads with "UseUV": 1 (tiled carbon…);
          // the first set stands in when the mesh has only one
          if (m.uv2 || m.uv) g.setAttribute('uv1', new THREE.BufferAttribute(m.uv2 ?? m.uv!, 2));
          if (m.uv2) g.setAttribute('luv1', new THREE.BufferAttribute(m.uv2, 2));
          // vertex colours (materials with vertColor tint by them); white when the mesh has none, so
          // such a material never reads an unset attribute. Stored as sRGB, three wants linear.
          {
            const n = m.pos.length;
            const c = new Float32Array(n).fill(1);
            if (m.col) for (let i = 0; i < n; i++) c[i] = srgbToLinear(m.col[i]);
            g.setAttribute('color', new THREE.BufferAttribute(c, 3));
            g.setAttribute('lcol', g.getAttribute('color'));
          }
          // explicit 0 / 1 per vertex (a missing attribute would read whatever its slot held last)
          g.setAttribute('lhas1', new THREE.BufferAttribute(new Float32Array(m.pos.length / 3).fill(m.uv2 ? 1 : 0), 1));
          // draw ranges per material (used by the Shaded mode; single-material draws ignore them)
          for (let k = 0; k < m.groups.length; k++) g.addGroup(m.groups[k].start, m.groups[k].count, k);
          g.userData.materials = m.groups.map((x) => x.material);
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

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
