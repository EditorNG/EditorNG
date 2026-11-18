/**
 * Pack a mod: what moderators reject (the game's NOTE_FOR_MODDERS.md) and what makes the download
 * bigger than it needs to be. Pure file inspection, no changes; fixes are separate calls.
 */
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parseJbeamFile } from '../core/jbeam/parts';
import { parseSjson, toJs } from '../core/sjson';
import { decodeText } from './vfs';

export type ModCategory = 'release' | 'before' | 'size' | 'tidy';

export interface ModIssue {
  sev: 'error' | 'warning' | 'info';
  cat: ModCategory;
  msg: string;
  file?: string;
  /** what can be done about it from the dialog */
  fix?: { kind: 'copyDds'; from: string; to: string } | { kind: 'exclude' };
  /** bytes the fix saves from the zip */
  saves?: number;
}

export interface ModScan {
  name: string;
  files: Array<{ rel: string; size: number }>;
  total: number;
  issues: ModIssue[];
  /** files left out of the zip unless the user keeps them (PNGs that have their DDS, leftovers) */
  exclude: string[];
}

export interface ScanDeps {
  userDir: string | undefined;
  gamePaths: () => Promise<Set<string>>;
  vanillaParts: () => Promise<Map<string, string>>;
  vanillaMaterials: () => Promise<Map<string, string>>;
}

const TEX = /\.(png|dds|jpe?g|tga)$/i;
const COOKABLE = /\.(color|normal|data)\.png$/i;
const LEFTOVER = (lc: string) =>
  /\.(txt|md|log|bak|blend\d*|psd|xcf|tmp|orig|kra|spp|max|ma|mb|fbx|obj|zip|rar|7z)$/i.test(lc) || /(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(lc) || /(^|\/)\.git\//.test(lc);
const PREVIEW = (lc: string) => /(^|\/)[^/]*(preview|default|thumb|_icon)[^/]*\.(png|jpe?g)$/i.test(lc) || /\.jpe?g$/i.test(lc);
const mb = (n: number) => `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`;
/** a texture path without its extension: "vehicles/x/a_b.color.png" -> "vehicles/x/a_b.color" */
const texKey = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase().replace(TEX, '');

export async function scanMod(modDir: string, deps: ScanDeps): Promise<ModScan> {
  const files: Array<{ rel: string; size: number }> = [];
  const walk = async (dir: string, rel: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(p, r);
      else files.push({ rel: r, size: (await fsp.stat(p)).size });
    }
  };
  await walk(modDir, '');
  const name = path.basename(modDir);
  const issues: ModIssue[] = [];
  const exclude = new Set<string>();
  const byLower = new Map(files.map((f) => [f.rel.toLowerCase(), f]));
  const [gamePaths, vparts, vmats] = await Promise.all([deps.gamePaths(), deps.vanillaParts(), deps.vanillaMaterials()]);

  // ---- name
  if (!/^[A-Za-z0-9_-]+$/.test(name)) issues.push({ sev: 'error', cat: 'release', msg: `The name "${name}" may only use A-Z a-z 0-9 - _ (it becomes the zip's name)` });
  if (/(^|[_-])v\d+([_-]\d+)*$/i.test(name) || /\d+\.\d+/.test(name)) issues.push({ sev: 'warning', cat: 'before', msg: 'Leave the version out of the name, so an update replaces the old zip' });

  // ---- materials of the mod: names and the textures they use
  const texRefs = new Map<string, string>(); // key -> material file that uses it
  const matNames = new Map<string, string>(); // lower name -> file
  for (const f of files.filter((x) => /materials\.json$/i.test(x.rel))) {
    let obj: any = null;
    try {
      obj = toJs(parseSjson(decodeText(await fsp.readFile(path.join(modDir, f.rel)))).root);
    } catch {
      issues.push({ sev: 'error', cat: 'release', msg: 'Could not read this materials file', file: f.rel });
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    for (const [key, m] of Object.entries<any>(obj)) {
      if (!m || typeof m !== 'object') continue;
      const nm = String(m.name ?? key);
      if (!matNames.has(nm.toLowerCase())) matNames.set(nm.toLowerCase(), f.rel);
      const visit = (x: any) => {
        if (typeof x === 'string') {
          if (TEX.test(x) && !x.startsWith('@')) texRefs.set(texKey(x), f.rel);
        } else if (x && typeof x === 'object') for (const v of Object.values(x)) visit(v);
      };
      visit(m.Stages ?? m);
    }
  }
  for (const [lc, file] of matNames) {
    const g = vmats.get(lc);
    if (g) issues.push({ sev: 'warning', cat: 'release', msg: `Material "${lc}" has the same name as a game material (${g}): one of them replaces the other for every player`, file });
  }

  // references by file name alone too (some materials name textures without their folder)
  const baseKey = (p: string) => texKey(p).slice(texKey(p).lastIndexOf('/') + 1);
  const refBase = new Set([...texRefs.keys()].map(baseKey));

  // ---- files
  const modTexKeys = new Set(files.filter((f) => TEX.test(f.rel)).map((f) => texKey(f.rel)));
  for (const f of files) {
    const lc = f.rel.toLowerCase();
    if (gamePaths.has(lc)) issues.push({ sev: 'error', cat: 'release', msg: 'Replaces a game file: give it a name or path of its own', file: f.rel });
    if (LEFTOVER(lc)) {
      issues.push({ sev: 'warning', cat: 'before', msg: 'Leftover file (notes, sources, backups): left out of the zip', file: f.rel, fix: { kind: 'exclude' }, saves: f.size });
      exclude.add(f.rel);
      continue;
    }
    if (lc.endsWith('.jbeam')) {
      try {
        const jf = parseJbeamFile(f.rel, decodeText(await fsp.readFile(path.join(modDir, f.rel))));
        const errs = jf.issues.filter((i) => i.sev === 'error');
        if (errs.length) issues.push({ sev: 'error', cat: 'release', msg: `${errs.length} syntax error${errs.length > 1 ? 's' : ''}: the game may skip the file (first: ${errs[0].msg})`, file: f.rel });
        // a part only meets the parts of its own vehicle folder and of vehicles/common
        const model = /^vehicles\/([^/]+)\//i.exec(f.rel)?.[1]?.toLowerCase();
        for (const p of jf.parts) {
          const where = (vparts.get(p.name.toLowerCase()) ?? '').split('|').filter(Boolean);
          const clash = where.find((w) => /^vehicles\/common\//i.test(w) || (model && w.toLowerCase().startsWith(`vehicles/${model}/`)));
          if (clash) issues.push({ sev: 'error', cat: 'release', msg: `Part "${p.name}" has the same name as a game part (${clash}): it replaces it for every player`, file: f.rel });
        }
      } catch {
        issues.push({ sev: 'warning', cat: 'release', msg: 'Could not read this .jbeam', file: f.rel });
      }
    }
    // textures
    if (!TEX.test(lc)) continue;
    if (COOKABLE.test(lc)) {
      const dds = lc.replace(/\.png$/i, '.dds');
      if (byLower.has(dds)) {
        issues.push({ sev: 'info', cat: 'size', msg: `The PNG ships next to its DDS: left out of the zip (materials keep naming the .png)`, file: f.rel, fix: { kind: 'exclude' }, saves: f.size });
        exclude.add(f.rel);
      } else {
        const cooked = deps.userDir ? path.join(deps.userDir, 'temp', ...f.rel.replace(/\.png$/i, '.dds').split('/')) : '';
        const st = cooked ? await fsp.stat(cooked).catch(() => null) : null;
        if (st) issues.push({ sev: 'warning', cat: 'size', msg: `The game already converted it (${mb(st.size)} DDS in temp/): copy the DDS next to it and ship that instead of the ${mb(f.size)} PNG`, file: f.rel, fix: { kind: 'copyDds', from: cooked, to: path.join(modDir, ...f.rel.replace(/\.png$/i, '.dds').split('/')) }, saves: f.size });
        else issues.push({ sev: 'warning', cat: 'size', msg: 'Not converted to DDS yet: load the vehicle once in the game, then check again', file: f.rel });
      }
    } else if (/\.png$/i.test(lc) && !PREVIEW(lc) && (texRefs.has(texKey(f.rel)) || refBase.has(baseKey(f.rel)))) {
      issues.push({ sev: 'info', cat: 'size', msg: 'Not named *.color.png / *.normal.png / *.data.png: the game never converts it, so it ships and loads as a full PNG', file: f.rel });
    }
    if (f.size > (lc.endsWith('.dds') ? 48 : 16) * 1048576 && !exclude.has(f.rel)) issues.push({ sev: 'info', cat: 'size', msg: `Large texture (${mb(f.size)}): is that resolution needed?`, file: f.rel });
    // used by a material of the mod?
    // only material textures (*.color / *.normal / *.data): UI icons and templates are not looked up by materials
    const isMatTex = /\.(color|normal|data)\.(png|dds)$/i.test(lc);
    if (isMatTex && texRefs.size && !texRefs.has(texKey(f.rel)) && !refBase.has(baseKey(f.rel)) && !exclude.has(f.rel)) {
      issues.push({ sev: 'info', cat: 'tidy', msg: 'No material of the mod uses this texture', file: f.rel, fix: { kind: 'exclude' }, saves: f.size });
    }
  }
  // textures the materials name that exist nowhere
  for (const [key, file] of texRefs) {
    if (modTexKeys.has(key)) continue;
    if (['.png', '.dds', '.jpg', '.color.png'].some((e) => gamePaths.has(key + e))) continue;
    if (gamePaths.has(key.replace(/\.(color|normal|data)$/, '') + '.dds')) continue;
    issues.push({ sev: 'warning', cat: 'release', msg: `A material uses "${key}", found neither in the mod nor in the game`, file });
  }

  // ---- vehicles: info file, preview, config cards
  const models = new Set(files.map((f) => /^vehicles\/([^/]+)\//i.exec(f.rel)?.[1]).filter((x): x is string => !!x && x.toLowerCase() !== 'common'));
  for (const m of models) {
    const ml = m.toLowerCase();
    const inModel = files.filter((f) => f.rel.toLowerCase().startsWith(`vehicles/${ml}/`));
    const isNew = inModel.some((f) => f.rel.toLowerCase().endsWith('.jbeam')) && ![...gamePaths].some((p) => p.startsWith(`vehicles/${ml}/`));
    if (isNew) {
      if (!inModel.some((f) => /^vehicles\/[^/]+\/info\.json$/i.test(f.rel))) issues.push({ sev: 'warning', cat: 'before', msg: `vehicles/${m}: no info.json (name, brand and type in the vehicle selector)` });
      if (!inModel.some((f) => /\/default\.(png|jpe?g)$/i.test(f.rel))) issues.push({ sev: 'warning', cat: 'before', msg: `vehicles/${m}: no default.jpg preview` });
    }
    for (const pc of inModel.filter((f) => /^vehicles\/[^/]+\/[^/]+\.pc$/i.test(f.rel))) {
      const base = pc.rel.replace(/\.pc$/i, '');
      const dir = base.slice(0, base.lastIndexOf('/') + 1), stem = base.slice(base.lastIndexOf('/') + 1);
      if (!byLower.has((dir + 'info_' + stem + '.json').toLowerCase())) issues.push({ sev: 'info', cat: 'before', msg: 'Configuration without info_<name>.json: it shows with its file name and no value', file: pc.rel });
      if (!['.jpg', '.png', '.jpeg'].some((e) => byLower.has((base + e).toLowerCase()))) issues.push({ sev: 'info', cat: 'before', msg: 'Configuration without a thumbnail (<name>.jpg)', file: pc.rel });
    }
  }

  const total = files.reduce((a, f) => a + f.size, 0);
  return { name, files, total, issues, exclude: [...exclude] };
}

/** Material names of the game's own materials.json files (lower case -> file). */
export async function gameMaterialNames(read: () => Promise<Array<{ vpath: string; text: string }>>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const { vpath, text } of await read()) {
    let obj: any = null;
    try {
      obj = toJs(parseSjson(text).root);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    for (const [key, m] of Object.entries<any>(obj)) {
      if (!m || typeof m !== 'object') continue;
      const nm = String(m.name ?? key).toLowerCase();
      if (!map.has(nm)) map.set(nm, vpath);
    }
  }
  return map;
}
