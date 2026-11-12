import { it } from 'vitest';
import { getVfs, loadVehicle } from './helpers';
import { placeTriggers } from '../src/core/jbeam/triggers';
import { readDae } from '../src/core/dae';
import { decodeText } from '../src/main/vfs';

/** Distance from each trigger centre to the closest vertex of the vehicle's visible (in-place) flexbodies. */
for (const model of ['covet', 'etk800', 'moonhawk', 'vivace', 'van', 'pickup']) {
  it(`triggers sit on visible geometry: ${model}`, async () => {
    const vfs = await getVfs();
    const { veh } = await loadVehicle(model);
    const v = veh!;
    const pos = new Float64Array(v.nodes.length * 3);
    v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
    const placed = placeTriggers(v, pos);
    const want = new Set(v.flexbodies.filter((f) => !f.pos && !f.rot).map((f) => f.mesh.toLowerCase()));
    const pts: number[] = [];
    const files = (await vfs.listTree('vehicles/' + model)).filter((f) => /\.dae$/i.test(f.vpath));
    for (const f of files) {
      const dae = readDae(decodeText(await vfs.read(f)));
      for (const name of dae.names) {
        if (!want.has(name.toLowerCase())) continue;
        const g = dae.build(name);
        if (!g) continue;
        for (let i = 0; i < g.pos.length; i += 3) pts.push(g.pos[i], g.pos[i + 1], g.pos[i + 2]);
      }
    }
    const nearest = (c: number[]) => {
      let b = Infinity;
      for (let i = 0; i < pts.length; i += 3) {
        const d = (pts[i] - c[0]) ** 2 + (pts[i + 1] - c[1]) ** 2 + (pts[i + 2] - c[2]) ** 2;
        if (d < b) b = d;
      }
      return Math.sqrt(b);
    };
    const rows = placed.map((t) => ({ t, d: nearest(t.center) })).sort((a, b) => b.d - a.d);
    const far = rows.filter((r) => r.d > 0.1);
    console.log(`${model}: ${placed.length} triggers, ${(pts.length / 3 / 1e3).toFixed(0)}k mesh vertices — within 10 cm of a surface: ${placed.length - far.length}/${placed.length}`);
    for (const r of far.slice(0, 8)) {
      const rv = r.t.row.v;
      console.log(`   ${(r.d * 100).toFixed(0).padStart(4)} cm  ${r.t.name.padEnd(22)} ${r.t.type}${r.t.usesGlobal ? ' global' : ' local'} part=${r.t.row.part.def.name} bt=${JSON.stringify(rv.baseTranslation)} br=${JSON.stringify(rv.baseRotation)} size=${JSON.stringify(rv.size)}`);
    }
  });
}
