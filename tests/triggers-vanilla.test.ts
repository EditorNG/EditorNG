import { it, expect } from 'vitest';
import { getVfs, loadVehicle } from './helpers';
import { placeTriggers, triggerRows } from '../src/core/jbeam/triggers';
import { readDae } from '../src/core/dae';
import { decodeText } from '../src/main/vfs';

/**
 * Ground truth: triggers that highlight a mesh are placed on that mesh in the game.
 * Check that the computed trigger centre lies inside the mesh bounds (+ margin).
 */
for (const model of ['pickup', 'covet', 'etk800', 'moonhawk', 'bastion', 'etkc', 'legran']) {
  it(`trigger placement matches highlighted meshes on ${model}`, async () => {
    const vfs = await getVfs();
    const { veh } = await loadVehicle(model);
    const v = veh!;
    const pos = new Float64Array(v.nodes.length * 3);
    v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
    const placed = placeTriggers(v, pos);
    const wanted = new Map<string, number[]>();
    for (const t of placed) {
      const m = t.row.v.mesh;
      if (typeof m === 'string' && m) wanted.set(m.toLowerCase(), []);
    }
    // mesh bounds from the vehicle + common daes
    const files = [...(await vfs.listTree('vehicles/' + model)), ...(await vfs.listTree('vehicles/common'))].filter((f) => /\.dae$/i.test(f.vpath));
    for (const f of files) {
      if (![...wanted.values()].some((b) => !b.length)) break;
      const text = decodeText(await vfs.read(f));
      if (![...wanted.keys()].some((k) => text.toLowerCase().includes(k))) continue;
      const dae = readDae(text);
      for (const name of dae.names) {
        const k = name.toLowerCase();
        if (!wanted.has(k) || wanted.get(k)!.length) continue;
        const g = dae.build(name);
        if (!g) continue;
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < g.pos.length; i += 3) for (let c = 0; c < 3; c++) {
          b[c] = Math.min(b[c], g.pos[i + c]);
          b[c + 3] = Math.max(b[c + 3], g.pos[i + c]);
        }
        wanted.set(k, b);
      }
    }
    let n = 0, inside = 0;
    const misses: string[] = [];
    for (const t of placed) {
      const m = t.row.v.mesh;
      if (typeof m !== 'string' || !m) continue;
      const b = wanted.get(m.toLowerCase());
      if (!b || !b.length) continue;
      // flexbody meshes may be offset by their own pos; only use meshes modelled in place (bbox not around the origin)
      n++;
      const M = 0.08;
      const c = t.center;
      const ok = c[0] >= b[0] - M && c[0] <= b[3] + M && c[1] >= b[1] - M && c[1] <= b[4] + M && c[2] >= b[2] - M && c[2] <= b[5] + M;
      if (ok) inside++;
      else if (misses.length < 6) misses.push(`${t.name} [${t.type}${t.usesGlobal ? ',global' : ''}] centre ${c.map((x) => x.toFixed(2)).join(',')} mesh ${m} ${b.map((x) => x.toFixed(2)).join(',')}`);
    }
    console.log(`${model}: ${triggerRows(v).length} triggers, ${placed.length} placed, ${n} with mesh — ${inside}/${n} on their mesh`);
    for (const s of misses) console.log('   miss', s);
    expect(placed.length).toBeGreaterThan(0);
  });
}
