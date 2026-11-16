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

  /** skins of the installed skin parts: material "<m>.<slot>.<skin>" replaces "<m>" (first match wins) */
  private skins: Array<{ slot: string; name: string }> = [];
  /** glowMap: material -> its "off" material (the vehicle as it stands, lights off) */
  private glow = new Map<string, string>();

  /** What the vehicle's parts say about materials: skin parts and glowMap entries. */
  setVehicleContext(skins: Array<{ slot: string; name: string }>, glow: Map<string, string>) {
    const key = JSON.stringify(skins) + '|' + JSON.stringify([...glow]);
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.skins = skins;
    this.glow = glow;
    this.clearMaterials();
  }
  private contextKey = '';

  /**
   * The material the game would draw for a mesh material name: the flexbody's materialOverride,
   * then the glowMap's "off" state, then the installed skin. Missing replacements keep the original.
   */
  resolve(name: string, override?: Map<string, string>): string {
    const has = (n: string) => this.index.has(n.toLowerCase()) || n.toLowerCase() === 'invis';
    let n = name;
    const o = override?.get(n.toLowerCase());
    if (o && has(o)) n = o;
    const g = this.glow.get(n.toLowerCase());
    if (g && has(g)) n = g;
    for (const s of this.skins) {
      const sk = `${n}.${s.slot}.${s.name}`;
      if (this.index.has(sk.toLowerCase())) return sk;
    }
    return n;
  }

  /** Material for a mesh material name (falls back to a neutral PBR grey). */
  material(raw: string, override?: Map<string, string>): THREE.Material {
    const name = this.resolve(raw, override);
    const key = name.toLowerCase();
    if (key === 'invis') return this.invisible();
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

  private static pixels = new Map<number, THREE.DataTexture>();
  /** a 1x1 grey-level texture (placeholder until a layer's real texture is loaded) */
  static pixel(v: number): THREE.DataTexture {
    let t = Shading.pixels.get(v);
    if (!t) {
      t = new THREE.DataTexture(new Uint8Array([v, v, v, 255]), 1, 1);
      t.needsUpdate = true;
      Shading.pixels.set(v, t);
    }
    return t;
  }

  private invisMat: THREE.Material | null = null;
  /** "invis": drawn as nothing (glowMap "off" states of lights use it) */
  private invisible() {
    if (!this.invisMat) {
      this.invisMat = new THREE.MeshBasicMaterial({ visible: false });
      this.invisMat.name = 'invis';
    }
    return this.invisMat;
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
    // a textured layer over the base (a livery): its colour / metal / roughness where its mask is
    // white, each map read with the UV set the material names. Placeholders until textures arrive:
    // a black mask shows the base meanwhile.
    const L = sp.layer;
    const layerU = L
      ? {
        layerColor: { value: Shading.pixel(255) as THREE.Texture },
        layerMask: { value: Shading.pixel(0) as THREE.Texture },
        layerMetal: { value: Shading.pixel(255) as THREE.Texture },
        layerTint: { value: new THREE.Color(L.color[0], L.color[1], L.color[2]) },
        layerMetalF: { value: L.metallic },
        layerRoughF: { value: L.roughness },
      }
      : null;
    const uvv = (k: number) => (k ? 'vLayerUv1' : 'vLayerUv0');
    const layerFrag = L
      ? `
  float layerA = texture2D( layerMask, ${uvv(L.maskUv)} ).r${L.maskUv || L.colorUv ? ' * vLayerHas1' : ''};
  vec4 layerC = texture2D( layerColor, ${uvv(L.colorUv)} );
  diffuseColor.rgb = mix( diffuseColor.rgb, layerC.rgb * layerTint, layerA );
  metalnessFactor = mix( metalnessFactor, layerMetalF * texture2D( layerMetal, ${uvv(L.metallicUv)} ).r, layerA );
  roughnessFactor = mix( roughnessFactor, layerRoughF, layerA );`
      : '';
    // BeamNG data maps are single channel (BC4 / greyscale): sample .r where three expects .g/.b,
    // and normal maps are two-channel (BC5): rebuild z.
    const rebuildZ = (chunk: string, v: string) => chunk.replace(new RegExp('(vec3 ' + v + ' = [^;]*;)'), `$1 ${v}.z = sqrt( max( 0.0, 1.0 - dot( ${v}.xy, ${v}.xy ) ) );`);
    m.onBeforeCompile = (sh) => {
      const C = THREE.ShaderChunk;
      Object.assign(sh.uniforms, paintU);
      if (layerU) {
        Object.assign(sh.uniforms, layerU);
        sh.vertexShader = 'attribute vec2 luv0;\nattribute vec2 luv1;\nattribute float lhas1;\nvarying vec2 vLayerUv0;\nvarying vec2 vLayerUv1;\nvarying float vLayerHas1;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vLayerUv0 = luv0;\n  vLayerUv1 = luv1;\n  vLayerHas1 = lhas1;');
        sh.fragmentShader = 'uniform sampler2D layerColor;\nuniform sampler2D layerMask;\nuniform sampler2D layerMetal;\nuniform vec3 layerTint;\nuniform float layerMetalF;\nuniform float layerRoughF;\nvarying vec2 vLayerUv0;\nvarying vec2 vLayerUv1;\nvarying float vLayerHas1;\n' + sh.fragmentShader;
        // the layer's clear coat stays on the layer: none on the bare base (raw carbon stays matte)
        if (L?.clearcoatOnLayer) sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\n  material.clearcoat *= layerA;\n#endif');
      }
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
              : '') +
            layerFrag,
        )
        .replace('#include <alphamap_fragment>', C.alphamap_fragment.replace('vAlphaMapUv ).g', 'vAlphaMapUv ).r'))
        .replace('#include <normal_fragment_maps>', rebuildZ(C.normal_fragment_maps, 'mapN'))
        // the clear coat follows the normal map too: without it the glossy layer reflects the
        // light as if the panel were perfectly flat, hiding the detail exactly where it is lit
        .replace('#include <clearcoat_normal_fragment_maps>', rebuildZ(C.clearcoat_normal_fragment_maps, 'clearcoatMapN'));
      if (layered) sh.fragmentShader = 'uniform vec3 paintColor;\nuniform float paintMetal;\nuniform float paintRough;\n' + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => 'beamng-pbr' + (layered ? '-layered' : '') + (L ? `-layer${L.colorUv}${L.maskUv}${L.metallicUv}${L.clearcoatOnLayer ? 'c' : ''}` : '');
    if (L && layerU) {
      const bind = (u: { value: THREE.Texture }, p: string | undefined, srgb: boolean) => {
        if (!p) return;
        this.texture(p, srgb).then((t) => {
          if (!t) return;
          u.value = t;
          this.onChange?.();
        });
      };
      bind(layerU.layerColor, L.colorMap, true);
      bind(layerU.layerMask, L.mask, false);
      bind(layerU.layerMetal, L.metallicMap, false);
    }
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
