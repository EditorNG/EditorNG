import { it, expect } from 'vitest';
import { getVfs } from './helpers';
import { parseMaterialsJson, indexMaterials, pbrOf, textureCandidates } from '../src/core/materials';
import { readDae } from '../src/core/dae';
import { decodeText } from '../src/main/vfs';

it('etk800: mesh materials resolve to materials.json entries with textures that exist', async () => {
  const vfs = await getVfs();
  const files = await vfs.listTree('vehicles/etk800');
  const matFiles = files.filter((f) => /materials\.json$/i.test(f.vpath));
  const texts = await vfs.readMany(matFiles);
  const defs = matFiles.flatMap((f, i) => parseMaterialsJson(decodeText(texts[i]), f.vpath));
  const idx = indexMaterials(defs);
  expect(defs.length).toBeGreaterThan(20);
  // one big mesh file
  const dae = files.filter((f) => /\.dae$/i.test(f.vpath)).sort((a, b) => b.size - a.size)[0];
  const d = readDae(decodeText(await vfs.read(dae)));
  const names = d.names.slice(0, 120);
  let groups = 0, found = 0, withUv = 0;
  const missing = new Set<string>();
  for (const n of names) {
    const m = d.build(n);
    if (!m) continue;
    if (m.uv) withUv++;
    for (const g of m.groups) {
      groups++;
      if (idx.has(g.material.toLowerCase())) found++;
      else missing.add(g.material);
    }
  }
  console.log(`${dae.vpath}: ${groups} groups, ${found} with a material, ${withUv} meshes with UVs; missing: ${[...missing].slice(0, 8).join(', ')}`);
  // some DAE materials are not defined in any game file (unused meshes): the game shows those unmaterialled too
  expect(found / Math.max(1, groups)).toBeGreaterThan(0.5);
  // textures of resolved materials can be found (png → dds fallback)
  let tex = 0, texFound = 0;
  for (const def of defs.slice(0, 40)) {
    const sp = pbrOf(def);
    for (const p of [sp.baseColorMap, sp.normalMap, sp.roughnessMap].filter(Boolean) as string[]) {
      tex++;
      for (const c of textureCandidates(p)) {
        if (await vfs.find(c)) {
          texFound++;
          break;
        }
      }
    }
  }
  console.log(`textures: ${texFound}/${tex} found`);
  expect(texFound / Math.max(1, tex)).toBeGreaterThan(0.7);
});
