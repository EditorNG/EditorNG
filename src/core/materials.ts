/**
 * BeamNG *.materials.json → one PBR description per material, for the Shaded view.
 * Handles the 1.5 PBR format (baseColorMap, metallic/roughness/AO/opacity maps, factors) and the
 * older stage format (colorMap/diffuseMap, instanceDiffuse = vehicle paint). Meshes refer to a
 * material by its `mapTo` name (or its name when there is no mapTo).
 */
import { parseSjson, toJs } from './sjson';

export interface MatDef {
  name: string;
  mapTo: string;
  file: string;
  version: number;
  stages: Array<Record<string, any>>;
  raw: Record<string, any>;
}

export interface PbrSpec {
  name: string;
  baseColor: [number, number, number, number];
  baseColorMap?: string;
  metallic: number;
  roughness: number;
  metallicMap?: string;
  roughnessMap?: string;
  normalMap?: string;
  aoMap?: string;
  opacityMap?: string;
  /** tinted with the vehicle paint */
  paint: boolean;
  clearcoat: number;
  transparent: boolean;
  alphaTest: number;
  doubleSided: boolean;
}

/** Parses a materials.json (tolerant: comments, trailing commas). Non-Material entries are skipped. */
export function parseMaterialsJson(text: string, file: string): MatDef[] {
  const res = parseSjson(text);
  const obj = res.root ? toJs(res.root) : null;
  if (!obj || typeof obj !== 'object') return [];
  const out: MatDef[] = [];
  for (const [key, m] of Object.entries<any>(obj)) {
    if (!m || typeof m !== 'object' || (m.class && m.class !== 'Material')) continue;
    const name = typeof m.name === 'string' ? m.name : key;
    out.push({
      name,
      mapTo: typeof m.mapTo === 'string' && m.mapTo ? m.mapTo : name,
      file,
      version: typeof m.version === 'number' ? m.version : 0,
      stages: Array.isArray(m.Stages) ? m.Stages.map((x: any) => (x && typeof x === 'object' ? x : {})) : [],
      raw: m,
    });
  }
  return out;
}

/** mapTo (and name) → definition; later files win like the game's load order would. */
export function indexMaterials(defs: MatDef[]): Map<string, MatDef> {
  const map = new Map<string, MatDef>();
  for (const d of defs) {
    map.set(d.mapTo.toLowerCase(), d);
    if (!map.has(d.name.toLowerCase())) map.set(d.name.toLowerCase(), d);
  }
  return map;
}

const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const path = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\\/g, '/').replace(/^\/+/, '') : undefined);

export function pbrOf(d: MatDef): PbrSpec {
  const st = d.stages;
  const s0 = st[0] ?? {};
  const raw = d.raw;
  const spec: PbrSpec = {
    name: d.name,
    baseColor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.6,
    paint: false,
    clearcoat: 0,
    transparent: raw.translucent === true,
    alphaTest: raw.alphaTest === true ? Math.max(0.05, num(raw.alphaRef, 127) / 255) : 0,
    doubleSided: raw.doubleSided === true,
  };
  const isPbr = d.version >= 1.5 || st.some((x) => 'baseColorMap' in x || 'baseColorFactor' in x || 'metallicFactor' in x);
  if (isPbr) {
    const bc = Array.isArray(s0.baseColorFactor) ? s0.baseColorFactor : null;
    if (bc) spec.baseColor = [num(bc[0], 1), num(bc[1], 1), num(bc[2], 1), num(bc[3], 1)];
    spec.baseColorMap = path(s0.baseColorMap);
    spec.metallic = num(s0.metallicFactor, s0.metallicMap ? 1 : 0);
    spec.roughness = num(s0.roughnessFactor, s0.roughnessMap ? 1 : 0.6);
    spec.metallicMap = path(s0.metallicMap);
    spec.roughnessMap = path(s0.roughnessMap);
    spec.normalMap = path(s0.normalMap);
    spec.aoMap = path(s0.ambientOcclusionMap);
    spec.opacityMap = path(s0.opacityMap);
    if (typeof s0.opacityFactor === 'number' && s0.opacityFactor < 1) {
      spec.baseColor[3] = s0.opacityFactor;
      spec.transparent = true;
    }
    // paint: instanceDiffuse / instanceBaseColor, or a colour palette map on any stage
    spec.paint = st.some((x) => x.instanceDiffuse === true || x.instanceBaseColor === true || !!x.colorPaletteMap);
    spec.clearcoat = Math.max(0, ...st.map((x) => num(x.clearCoatFactor, 0)));
  } else {
    // older stage format: base colour from the paint stage when there is one, else the first map
    const paintStage = st.find((x) => x.instanceDiffuse === true);
    const colorStage = paintStage ?? st.find((x) => x.colorMap || x.diffuseMap || x.baseTexture);
    const c = colorStage ?? s0;
    spec.baseColorMap = path(c.colorMap ?? c.diffuseMap ?? c.baseTexture);
    const dc = Array.isArray(c.diffuseColor) ? c.diffuseColor : null;
    if (dc) spec.baseColor = [num(dc[0], 1), num(dc[1], 1), num(dc[2], 1), num(dc[3], 1)];
    spec.normalMap = path(st.find((x) => x.normalMap)?.normalMap);
    spec.roughness = num(c.roughnessFactor ?? s0.roughnessFactor, 0.55);
    spec.paint = !!paintStage;
    if (spec.paint) {
      spec.metallic = 0.4;
      spec.clearcoat = 1;
    }
  }
  if (spec.opacityMap || spec.baseColor[3] < 1) spec.transparent = true;
  return spec;
}

/**
 * Texture paths in materials usually name the source .png while the game ships the cooked .dds
 * next to it: candidates in the order the game would find them.
 */
export function textureCandidates(p: string): string[] {
  const out = [p];
  if (/\.(png|jpe?g|tga)$/i.test(p)) out.push(p.replace(/\.(png|jpe?g|tga)$/i, '.dds'));
  if (!/\.\w+$/.test(p)) out.push(p + '.dds', p + '.png');
  return out;
}
