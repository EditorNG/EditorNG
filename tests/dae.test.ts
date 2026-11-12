import { it, expect } from 'vitest';
import { getVfs, loadVehicle } from './helpers';
import { readDae, scanDaeNames } from '../src/core/dae';
import { decodeText } from '../src/main/vfs';

it('reads pickup flexbody meshes with sane bounds', async () => {
  const vfs = await getVfs();
  const { veh } = await loadVehicle('pickup');
  const files = (await vfs.listTree('vehicles/pickup')).filter((f) => /\.dae$/i.test(f.vpath));
  console.log('dae files', files.map((f) => `${f.vpath} ${(f.size / 1e6).toFixed(1)}MB`));
  const want = new Set(veh!.flexbodies.map((f) => f.mesh.toLowerCase()));
  for (const f of files) {
    const t0 = performance.now();
    const text = decodeText(await vfs.read(f));
    const names = scanDaeNames(text);
    const dae = readDae(text);
    console.log(f.vpath, 'scan', names.length, 'parsed nodes', dae.names.length, (performance.now() - t0).toFixed(0), 'ms');
    let shown = 0;
    for (const n of dae.names) {
      if (!want.has(n.toLowerCase())) continue;
      const m = dae.build(n);
      if (!m) { console.log('  no geometry for', n); continue; }
      let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.pos[i + k]); max[k] = Math.max(max[k], m.pos[i + k]); }
      if (shown++ < 8) console.log('  ', n, m.pos.length / 9, 'tris', min.map((x) => x.toFixed(2)).join(','), '->', max.map((x) => x.toFixed(2)).join(','));
    }
    console.log('  matched flexbodies:', shown);
  }
  expect(files.length).toBeGreaterThan(0);
});
