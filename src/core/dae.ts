/**
 * Minimal, fast COLLADA (.dae) reader for BeamNG meshes. Runs in a worker (no DOMParser there).
 * Extracts triangle geometry per scene node name, baked into document space (Z up, metres).
 */

interface XEl {
  tag: string;
  attrs: Record<string, string>;
  children: XEl[];
  text: string;
}

const ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Small non-validating XML parser: elements, attributes and text; ignores comments/PIs/CDATA. */
export function parseXml(src: string): XEl {
  const root: XEl = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: XEl[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const top = stack[stack.length - 1];
      // only keep text for leaf-ish elements (float arrays, p, matrices)
      if (top.children.length === 0) top.text += src.slice(i, lt);
    }
    const c = src.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (src.startsWith('<!--', lt)) {
        const e = src.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (src.startsWith('<![CDATA[', lt)) {
        const e = src.indexOf(']]>', lt + 9);
        i = e < 0 ? n : e + 3;
      } else {
        const e = src.indexOf('>', lt);
        i = e < 0 ? n : e + 1;
      }
      continue;
    }
    if (c === 63 /* ? */) {
      const e = src.indexOf('?>', lt);
      i = e < 0 ? n : e + 2;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    if (c === 47 /* / */) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = src.charCodeAt(gt - 1) === 47;
    const inner = src.slice(lt + 1, selfClose ? gt - 1 : gt);
    let sp = 0;
    while (sp < inner.length && !/\s/.test(inner[sp])) sp++;
    const tag = inner.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp < inner.length) {
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      const rest = inner.slice(sp);
      while ((m = ATTR_RE.exec(rest))) attrs[m[1]] = m[3] ?? m[4] ?? '';
    }
    const el: XEl = { tag, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }
  return root;
}

function child(el: XEl | undefined, tag: string): XEl | undefined {
  return el?.children.find((c) => c.tag === tag);
}
function childrenOf(el: XEl | undefined, tag: string): XEl[] {
  return el ? el.children.filter((c) => c.tag === tag) : [];
}

function parseFloats(text: string): Float32Array {
  const parts = text.trim().split(/\s+/);
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = +parts[i];
  return out;
}
function parseInts(text: string): Int32Array {
  const t = text.trim();
  if (!t) return new Int32Array(0);
  const parts = t.split(/\s+/);
  const out = new Int32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = parts[i] as any | 0;
  return out;
}

type Mat4 = Float64Array; // column-major like three.js

function ident(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function fromRowMajor(v: Float32Array): Mat4 {
  const m = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = v[r * 4 + c];
  return m;
}
function translate(x: number, y: number, z: number): Mat4 {
  const m = ident();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}
function scale(x: number, y: number, z: number): Mat4 {
  const m = ident();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}
function rotate(ax: number, ay: number, az: number, deg: number): Mat4 {
  const l = Math.hypot(ax, ay, az) || 1;
  const x = ax / l, y = ay / l, z = az / l;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r), t = 1 - c;
  const m = ident();
  m[0] = t * x * x + c; m[4] = t * x * y - s * z; m[8] = t * x * z + s * y;
  m[1] = t * x * y + s * z; m[5] = t * y * y + c; m[9] = t * y * z - s * x;
  m[2] = t * x * z - s * y; m[6] = t * y * z + s * x; m[10] = t * z * z + c;
  return m;
}

function nodeLocal(el: XEl): Mat4 {
  let m = ident();
  for (const c of el.children) {
    if (c.tag === 'matrix') m = mul(m, fromRowMajor(parseFloats(c.text)));
    else if (c.tag === 'translate') {
      const v = parseFloats(c.text);
      m = mul(m, translate(v[0], v[1], v[2]));
    } else if (c.tag === 'rotate') {
      const v = parseFloats(c.text);
      m = mul(m, rotate(v[0], v[1], v[2], v[3]));
    } else if (c.tag === 'scale') {
      const v = parseFloats(c.text);
      m = mul(m, scale(v[0], v[1], v[2]));
    }
  }
  return m;
}

export interface DaeMesh {
  name: string;
  /** non-indexed triangle positions, document space */
  pos: Float32Array;
  /** flat normals per vertex */
  nrm: Float32Array;
  /** material name per draw range */
  groups: Array<{ material: string; start: number; count: number }>;
}

interface Geo {
  tris: Array<{ material: string; idx: Float32Array }>;
}

function readGeometry(geo: XEl): Geo | null {
  const mesh = child(geo, 'mesh');
  if (!mesh) return null;
  const sources = new Map<string, { data: Float32Array; stride: number }>();
  for (const s of childrenOf(mesh, 'source')) {
    const fa = child(s, 'float_array');
    if (!fa) continue;
    const acc = child(child(s, 'technique_common'), 'accessor');
    sources.set(s.attrs.id, { data: parseFloats(fa.text), stride: acc ? +acc.attrs.stride || 3 : 3 });
  }
  const vertices = child(mesh, 'vertices');
  let posSrc: { data: Float32Array; stride: number } | undefined;
  if (vertices) {
    for (const inp of childrenOf(vertices, 'input')) if (inp.attrs.semantic === 'POSITION') posSrc = sources.get(inp.attrs.source.slice(1));
  }
  const out: Geo = { tris: [] };
  for (const prim of mesh.children) {
    if (prim.tag !== 'triangles' && prim.tag !== 'polylist' && prim.tag !== 'polygons') continue;
    const inputs = childrenOf(prim, 'input');
    let stride = 0;
    let vOff = 0;
    let src = posSrc;
    for (const inp of inputs) {
      const off = +inp.attrs.offset || 0;
      stride = Math.max(stride, off + 1);
      if (inp.attrs.semantic === 'VERTEX') vOff = off;
      else if (inp.attrs.semantic === 'POSITION') {
        vOff = off;
        src = sources.get(inp.attrs.source.slice(1));
      }
    }
    if (!src) continue;
    const ps = prim.tag === 'polygons' ? childrenOf(prim, 'p').map((p) => parseInts(p.text)) : [parseInts(child(prim, 'p')?.text ?? '')];
    const vcount = prim.tag === 'polylist' ? parseInts(child(prim, 'vcount')?.text ?? '') : null;
    const verts: number[] = [];
    const pushV = (p: Int32Array, k: number) => {
      const vi = p[k * stride + vOff];
      const o = vi * src!.stride;
      verts.push(src!.data[o], src!.data[o + 1], src!.data[o + 2]);
    };
    if (prim.tag === 'triangles') {
      const p = ps[0];
      const nv = Math.floor(p.length / stride);
      for (let k = 0; k + 2 < nv + 0 && k < nv; k += 3) {
        pushV(p, k);
        pushV(p, k + 1);
        pushV(p, k + 2);
      }
    } else if (vcount) {
      const p = ps[0];
      let base = 0;
      for (let f = 0; f < vcount.length; f++) {
        const c = vcount[f];
        for (let k = 1; k + 1 < c; k++) {
          pushV(p, base);
          pushV(p, base + k);
          pushV(p, base + k + 1);
        }
        base += c;
      }
    } else {
      for (const p of ps) {
        const c = Math.floor(p.length / stride);
        for (let k = 1; k + 1 < c; k++) {
          pushV(p, 0);
          pushV(p, k);
          pushV(p, k + 1);
        }
      }
    }
    out.tris.push({ material: prim.attrs.material ?? '', idx: new Float32Array(verts) });
  }
  return out;
}

export interface DaeFile {
  /** node / geometry names -> builder */
  names: string[];
  build(name: string): DaeMesh | null;
}

export function readDae(text: string): DaeFile {
  const doc = parseXml(text);
  const collada = child(doc, 'COLLADA') ?? doc.children[0];
  const asset = child(collada, 'asset');
  const unit = +(child(asset, 'unit')?.attrs.meter ?? 1) || 1;
  const up = (child(asset, 'up_axis')?.text ?? 'Z_UP').trim();
  let root = scale(unit, unit, unit);
  if (up === 'Y_UP') root = mul(root, rotate(1, 0, 0, 90));
  const geomEls = new Map<string, XEl>();
  for (const lib of childrenOf(collada, 'library_geometries')) for (const g of childrenOf(lib, 'geometry')) geomEls.set(g.attrs.id, g);
  const libNodes = new Map<string, XEl>();
  for (const lib of childrenOf(collada, 'library_nodes')) for (const nd of childrenOf(lib, 'node')) libNodes.set(nd.attrs.id, nd);
  const geoCache = new Map<string, Geo | null>();
  const geo = (id: string) => {
    if (!geoCache.has(id)) {
      const el = geomEls.get(id);
      geoCache.set(id, el ? readGeometry(el) : null);
    }
    return geoCache.get(id)!;
  };
  // collect scene nodes with their world matrices
  const nodes = new Map<string, Array<{ m: Mat4; geos: string[] }>>();
  const visit = (el: XEl, parent: Mat4, depth: number) => {
    if (depth > 64) return;
    const m = mul(parent, nodeLocal(el));
    const geos = childrenOf(el, 'instance_geometry').map((g) => g.attrs.url?.slice(1) ?? '');
    const nm = (el.attrs.name ?? el.attrs.id ?? '').trim();
    if (nm) {
      let l = nodes.get(nm);
      if (!l) nodes.set(nm, (l = []));
      l.push({ m, geos });
    }
    for (const c of el.children) {
      if (c.tag === 'node') visit(c, m, depth + 1);
      else if (c.tag === 'instance_node') {
        const ref = libNodes.get(c.attrs.url?.slice(1) ?? '');
        if (ref) visit(ref, m, depth + 1);
      }
    }
  };
  for (const lib of childrenOf(collada, 'library_visual_scenes'))
    for (const vs of childrenOf(lib, 'visual_scene')) for (const nd of childrenOf(vs, 'node')) visit(nd, root, 0);
  // geometry names too (some meshes are referenced by geometry name)
  const geoByName = new Map<string, string>();
  for (const [id, el] of geomEls) {
    const nm = (el.attrs.name ?? '').trim();
    if (nm && !nodes.has(nm)) geoByName.set(nm, id);
  }

  const build = (name: string): DaeMesh | null => {
    const entries = nodes.get(name);
    const parts: Array<{ m: Mat4; g: Geo }> = [];
    if (entries) {
      for (const e of entries) for (const gid of e.geos) {
        const g = geo(gid);
        if (g) parts.push({ m: e.m, g });
      }
    }
    if (!parts.length) {
      const gid = geoByName.get(name);
      const g = gid ? geo(gid) : null;
      if (g) parts.push({ m: root, g });
    }
    if (!parts.length) return null;
    let total = 0;
    for (const p of parts) for (const t of p.g.tris) total += t.idx.length;
    const pos = new Float32Array(total);
    const nrm = new Float32Array(total);
    const groups: DaeMesh['groups'] = [];
    let o = 0;
    for (const p of parts) {
      const m = p.m;
      for (const t of p.g.tris) {
        const src = t.idx;
        const start = o / 3;
        for (let i = 0; i < src.length; i += 3) {
          const x = src[i], y = src[i + 1], z = src[i + 2];
          pos[o + i] = m[0] * x + m[4] * y + m[8] * z + m[12];
          pos[o + i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          pos[o + i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        // flat normals
        for (let i = 0; i < src.length; i += 9) {
          const ax = pos[o + i], ay = pos[o + i + 1], az = pos[o + i + 2];
          const ux = pos[o + i + 3] - ax, uy = pos[o + i + 4] - ay, uz = pos[o + i + 5] - az;
          const vx = pos[o + i + 6] - ax, vy = pos[o + i + 7] - ay, vz = pos[o + i + 8] - az;
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          for (let k = 0; k < 3; k++) {
            nrm[o + i + k * 3] = nx;
            nrm[o + i + k * 3 + 1] = ny;
            nrm[o + i + k * 3 + 2] = nz;
          }
        }
        groups.push({ material: t.material, start, count: src.length / 3 });
        o += src.length;
      }
    }
    return { name, pos, nrm, groups };
  };

  return { names: [...nodes.keys(), ...geoByName.keys()], build };
}

/** Fast name scan without building geometry (for indexing big files). */
export function scanDaeNames(text: string): string[] {
  const out = new Set<string>();
  const re = /<(node|geometry)\b[^>]*?\bname="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[2].trim());
  return [...out];
}
