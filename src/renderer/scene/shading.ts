/**
 * "Shaded" view: BeamNG materials (*.materials.json) as three.js PBR materials, textures from the
 * game/mod files (DDS or PNG/JPG), lit by a studio environment (three's RoomEnvironment) or a
 * user-chosen .hdr.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { toast } from '../state/toast';
import { api } from '../lib/api';
import { ws, useWs } from '../project/workspace';
import { settings } from '../state/settings';
import { parseMaterialsJson, indexMaterials, pbrOf, textureCandidates, type MatDef, type PbrSpec } from '@core/materials';
import { parseDds } from './dds';
import type { VFile } from '@shared/ipc';

class Shading {
  private index = new Map<string, MatDef>();
  private indexKey = '';
  private loading: Promise<void> | null = null;
  private mats = new Map<string, THREE.Material>();
  private tex = new Map<string, Promise<THREE.Texture | null>>();
  private env: { key: string; tex: THREE.Texture } | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  /** called when textures arrive (to redraw) */
  onChange: (() => void) | null = null;
  missing = new Set<string>();

  /** Reads every materials.json of the vehicle folder, the common folder and open loose files. */
  load(): Promise<void> {
    const key = (ws.model ?? '') + '|' + [...ws.docs.keys()].filter((k) => /materials\.json$/i.test(k)).join(',');
    if (key === this.indexKey && this.loading) return this.loading;
    this.indexKey = key;
    this.clearMaterials();
    this.loading = (async () => {
      const lists: VFile[][] = await Promise.all([
        ws.model ? api.listTree('vehicles/' + ws.model) : Promise.resolve([] as VFile[]),
        api.listTree('vehicles/common'),
      ]);
      // common first, then the vehicle: the vehicle's definitions win
      const files = [...lists[1], ...lists[0]].filter((f) => /materials\.json$/i.test(f.vpath));
      const texts = await api.readTexts(files);
      const defs: MatDef[] = [];
      files.forEach((f, i) => defs.push(...parseMaterialsJson(texts[i], f.vpath)));
      // loose files: materials.json next to them / open in the editor
      for (const d of ws.docs.values()) if (/materials\.json$/i.test(d.vpath) && !files.some((f) => f.vpath.toLowerCase() === d.vpath.toLowerCase())) defs.push(...parseMaterialsJson(d.text, d.vpath));
      this.index = indexMaterials(defs);
    })();
    return this.loading;
  }

  private clearMaterials() {
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
    this.missing.clear();
  }

  /** Paint of the active .pc (first entry of "paints", saved by the game), else a mid metallic grey-blue. */
  paint(): { color: THREE.Color; metallic?: number; roughness?: number } {
    const cfg = ws.doc(useWs.getState().activeConfig);
    try {
      const pc = cfg ? JSON.parse(cfg.text) : null;
      const p = pc?.paints?.[0];
      const c = p?.baseColor ?? pc?.colors?.[0];
      if (Array.isArray(c) && c.length >= 3) {
        return {
          color: new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace),
          metallic: typeof p?.metallic === 'number' ? p.metallic : undefined,
          roughness: typeof p?.roughness === 'number' ? p.roughness : undefined,
        };
      }
    } catch {
      /* not JSON */
    }
    return { color: new THREE.Color().setRGB(0.36, 0.4, 0.46, THREE.SRGBColorSpace), metallic: 0.55, roughness: 0.32 };
  }

  /** Material for a mesh material name (falls back to a neutral PBR grey). */
  material(name: string): THREE.Material {
    const key = name.toLowerCase();
    let m = this.mats.get(key);
    if (m) return m;
    const def = this.index.get(key);
    if (!def) {
      this.missing.add(name);
      m = this.fallback();
    } else m = this.build(pbrOf(def));
    this.mats.set(key, m);
    return m;
  }

  private fallbackMat: THREE.MeshStandardMaterial | null = null;
  private fallback() {
    if (!this.fallbackMat) this.fallbackMat = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
    return this.fallbackMat;
  }

  private build(sp: PbrSpec): THREE.Material {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(sp.baseColor[0], sp.baseColor[1], sp.baseColor[2]),
      metalness: sp.metallic,
      roughness: sp.roughness,
      transparent: sp.transparent,
      opacity: sp.baseColor[3],
      alphaTest: sp.alphaTest,
      side: THREE.DoubleSide,
      depthWrite: !sp.transparent,
      clearcoat: sp.clearcoat,
      clearcoatRoughness: sp.clearcoatRoughness,
    });
    m.name = sp.name;
    const pt = sp.paint ? this.paint() : null;
    // layered (paint stage over a base stage): paint colour / metal / roughness are blended in by
    // the mask in the shader, and the mask also limits the clear coat (clearcoatMap)
    const layered = !!(pt && sp.paintMask);
    const paintU = {
      paintColor: { value: pt ? pt.color.clone() : new THREE.Color(1, 1, 1) },
      paintMetal: { value: pt?.metallic ?? 0.55 },
      paintRough: { value: pt?.roughness ?? 0.32 },
    };
    // the mask rides on clearcoatMap, which three only binds when the clear coat is on
    if (layered && m.clearcoat === 0) m.clearcoat = 1e-4;
    if (pt && !layered) {
      m.color.multiply(pt.color);
      if (pt.metallic !== undefined && !sp.metallicMap) m.metalness = pt.metallic;
      if (pt.roughness !== undefined && !sp.roughnessMap) m.roughness = pt.roughness;
    }
    // BeamNG data maps are single channel (BC4 / greyscale): sample .r where three expects .g/.b,
    // and normal maps are two-channel (BC5): rebuild z.
    const rebuildZ = (chunk: string, v: string) => chunk.replace(new RegExp('(vec3 ' + v + ' = [^;]*;)'), `$1 ${v}.z = sqrt( max( 0.0, 1.0 - dot( ${v}.xy, ${v}.xy ) ) );`);
    m.onBeforeCompile = (sh) => {
      const C = THREE.ShaderChunk;
      Object.assign(sh.uniforms, paintU);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', C.roughnessmap_fragment.replace('texelRoughness.g', 'texelRoughness.r'))
        .replace(
          '#include <metalnessmap_fragment>',
          C.metalnessmap_fragment.replace('texelMetalness.b', 'texelMetalness.r') +
            (layered
              ? `
#ifdef USE_CLEARCOATMAP
  float paintMask = texture2D( clearcoatMap, vClearcoatMapUv ).r;
  diffuseColor.rgb = mix( diffuseColor.rgb, paintColor, paintMask );
  metalnessFactor = mix( metalnessFactor, paintMetal, paintMask );
  roughnessFactor = mix( roughnessFactor, paintRough, paintMask );
#endif`
              : ''),
        )
        .replace('#include <alphamap_fragment>', C.alphamap_fragment.replace('vAlphaMapUv ).g', 'vAlphaMapUv ).r'))
        .replace('#include <normal_fragment_maps>', rebuildZ(C.normal_fragment_maps, 'mapN'))
        // the clear coat follows the normal map too: without it the glossy layer reflects the
        // light as if the panel were perfectly flat, hiding the detail exactly where it is lit
        .replace('#include <clearcoat_normal_fragment_maps>', rebuildZ(C.clearcoat_normal_fragment_maps, 'clearcoatMapN'));
      if (layered) sh.fragmentShader = 'uniform vec3 paintColor;\nuniform float paintMetal;\nuniform float paintRough;\n' + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => 'beamng-pbr' + (layered ? '-layered' : '');
    const set = (slot: 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'aoMap' | 'alphaMap' | 'clearcoatMap', p: string | undefined, srgb: boolean) => {
      if (!p) return;
      this.texture(p, srgb).then((t) => {
        if (!t) return;
        (m as any)[slot] = t;
        if (slot === 'normalMap') {
          m.normalScale.set(1, -1);
          if (m.clearcoat > 0) {
            m.clearcoatNormalMap = t;
            m.clearcoatNormalScale.set(1, -1);
          }
        }
        if (slot === 'roughnessMap') m.roughness = 1;
        if (slot === 'metalnessMap') m.metalness = 1;
        m.needsUpdate = true;
        this.onChange?.();
      });
    };
    set('map', sp.baseColorMap, true);
    set('normalMap', sp.normalMap, false);
    set('roughnessMap', sp.roughnessMap, false);
    set('metalnessMap', sp.metallicMap, false);
    set('aoMap', sp.aoMap, false);
    set('alphaMap', sp.opacityMap, false);
    if (layered) set('clearcoatMap', sp.paintMask, false);
    return m;
  }

  /** Loads a texture by game path, trying the cooked .dds when the material names a .png. */
  texture(path: string, srgb: boolean): Promise<THREE.Texture | null> {
    const key = path.toLowerCase() + (srgb ? '|s' : '');
    let p = this.tex.get(key);
    if (p) return p;
    p = (async () => {
      const r = this.renderer;
      if (!r) return null;
      for (const c of textureCandidates(path)) {
        const f = await api.findFile(c).catch(() => null);
        if (!f) continue;
        const bytes = f.real ? await api.readBinaryFile(f.real) : await api.readBinary(f);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        if (/\.dds$/i.test(f.vpath)) {
          const t = parseDds(buf, r, srgb);
          if (t) return t;
          continue;
        }
        try {
          const bmp = await createImageBitmap(new Blob([buf]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const t = new THREE.Texture(bmp as any);
          t.flipY = false;
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = Math.min(8, r.capabilities.getMaxAnisotropy());
          t.needsUpdate = true;
          return t;
        } catch {
          /* not an image the browser can decode (tga…) */
        }
      }
      return null;
    })();
    this.tex.set(key, p);
    return p;
  }

  /** Studio room, or the user's .hdr (Settings → 3D view). */
  async environment(): Promise<THREE.Texture | null> {
    const r = this.renderer;
    if (!r) return null;
    const hdr = settings().shadedEnvHdr;
    const key = hdr ? hdr + '|' + settings().shadedEnvBrightness : 'room|' + settings().shadedEnvBrightness;
    if (this.env?.key === key) return this.env.tex;
    const pm = new THREE.PMREMGenerator(r);
    let tex: THREE.Texture | null = null;
    if (hdr) {
      try {
        const bytes = await api.readBinaryFile(hdr);
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        // .exr (OpenEXR) or .hdr (Radiance), by extension
        const data = (/.exr$/i.test(hdr) ? new EXRLoader().setDataType(THREE.FloatType).parse(buf) : new HDRLoader().setDataType(THREE.FloatType).parse(buf)) as any;
        if (!data?.data?.length) throw new Error('no image data');
        normalizeHdr(data.data as Float32Array, data.format === THREE.RedFormat ? 1 : data.format === THREE.RGFormat ? 2 : 4, settings().shadedEnvBrightness);
        const dt = new THREE.DataTexture(data.data, data.width, data.height, data.format ?? THREE.RGBAFormat, THREE.FloatType);
        dt.colorSpace = THREE.LinearSRGBColorSpace;
        dt.mapping = THREE.EquirectangularReflectionMapping;
        dt.needsUpdate = true;
        tex = pm.fromEquirectangular(dt).texture;
        dt.dispose();
      } catch (e: any) {
        tex = null;
        toast('warn', `Could not read ${hdr.split(/[\/]/).pop()} (${e?.message ?? e}); using the built-in studio`);
      }
    }
    if (!tex) tex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    this.env?.tex.dispose();
    this.env = { key, tex };
    return tex;
  }

  /** Forget everything tied to the open vehicle (materials, textures). */
  reset() {
    this.clearMaterials();
    for (const p of this.tex.values()) p.then((t) => t?.dispose());
    this.tex.clear();
    this.indexKey = '';
    this.loading = null;
  }
}

export const shading = new Shading();

/**
 * HDRIs come at their real-world brightness (a sunny sky is thousands of times brighter than a
 * studio). Scale pixels so the average luminance lands where the built-in studio sits, times the
 * user's brightness. The sun is clamped first so a tiny hot spot does not decide the average.
 */
export function normalizeHdr(px: Float32Array, channels: number, brightness: number) {
  let sum = 0, n = 0;
  const lum = (i: number) => (channels >= 3 ? 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] : px[i]);
  // median-ish reference: mean of luminance clamped at 50× a rough first mean
  let rough = 0;
  for (let i = 0; i < px.length; i += channels * 7) {
    const l = lum(i);
    if (Number.isFinite(l)) {
      rough += l;
      n++;
    }
  }
  rough = n ? rough / n : 1;
  n = 0;
  for (let i = 0; i < px.length; i += channels) {
    const l = lum(i);
    if (!Number.isFinite(l)) continue;
    sum += Math.min(l, rough * 50);
    n++;
  }
  const mean = n ? sum / n : 1;
  const k = mean > 0 ? (0.5 * brightness) / mean : 1;
  for (let i = 0; i < px.length; i++) {
    if (channels === 4 && i % 4 === 3) continue;
    const v = px[i] * k;
    px[i] = Number.isFinite(v) ? Math.min(v, 64) : 0;
  }
}
