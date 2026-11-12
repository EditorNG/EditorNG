import { it } from 'vitest';
import * as THREE from 'three';
import { getVfs, loadVehicle } from './helpers';
import { readDae } from '../src/core/dae';
import { decodeText } from '../src/main/vfs';
import { rotateBng } from '../src/core/jbeam/nodeTransform';

const D = Math.PI / 180;

async function meshBank(model: string, names: Set<string>, local = false) {
  const vfs = await getVfs();
  const files = [...(await vfs.listTree('vehicles/' + model)), ...(await vfs.listTree('vehicles/common'))].filter((f) => /\.dae$/i.test(f.vpath));
  const out = new Map<string, Float32Array>();
  for (const f of files) {
    if ([...names].every((n) => out.has(n))) break;
    const text = decodeText(await vfs.read(f));
    const lc = text.toLowerCase();
    if (![...names].some((n) => !out.has(n) && lc.includes(n))) continue;
    const d = readDae(text);
    for (const n of d.names) {
      const k = n.toLowerCase();
      if (names.has(k) && !out.has(k)) {
        const g = d.build(n, local);
        if (g) out.set(k, g.pos);
      }
    }
  }
  return out;
}

for (const model of ['pickup', 'etk800', 'covet']) {
  it(`wheel-area flexbodies sit on their nodes: ${model}`, async () => {
    const { veh } = await loadVehicle(model);
    const v = veh!;
    const fl = v.flexbodies.filter((f) => f.groups.some((g) => /wheel|hub|brake|tire/i.test(g)));
    const bank = await meshBank(model, new Set(fl.map((f) => f.mesh.toLowerCase())));
    let ok = 0, n = 0;
    const bad: string[] = [];
    for (const f of fl) {
      const pts = bank.get(f.mesh.toLowerCase());
      if (!pts) continue;
      const nodes = v.nodes.filter((nd) => nd.groups.some((g) => f.groups.includes(g)));
      if (!nodes.length) continue;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(...(f.pos ?? [0, 0, 0])),
        new THREE.Quaternion().setFromEuler(new THREE.Euler((f.rot?.[0] ?? 0) * D, (f.rot?.[1] ?? 0) * D, (f.rot?.[2] ?? 0) * D, 'ZXY')),
        new THREE.Vector3(...(f.scale ?? [1, 1, 1]).map((x) => x || 1)),
      );
      const b = new THREE.Box3();
      const p = new THREE.Vector3();
      for (let i = 0; i < pts.length; i += 3) b.expandByPoint(p.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(m));
      const nc = new THREE.Vector3();
      for (const nd of nodes) nc.add(new THREE.Vector3(nd.x, nd.y, nd.z).divideScalar(nodes.length));
      const c = b.getCenter(new THREE.Vector3());
      const d = Math.abs(c.x - nc.x) + Math.abs(c.y - nc.y) * 0 + Math.abs(c.z - nc.z);
      n++;
      if (d < 0.12) ok++;
      else if (bad.length < 4) bad.push(`${f.mesh} [${f.groups.join(',')}] mesh ${c.toArray().map((x) => x.toFixed(2))} nodes ${nc.toArray().map((x) => x.toFixed(2))}`);
    }
    console.log(`${model}: ${ok}/${n} wheel-area flexbodies within 12 cm (x/z) of their nodes`);
    for (const b of bad) console.log('   ', b);
  });
}

it('occupant head prop sits on the neck/head nodes', async () => {
  const { veh } = await loadVehicle('etk800');
  const v = veh!;
  const bank = await meshBank('etk800', new Set(['character_head']), true);
  const head = bank.get('character_head')!;
  for (const p of v.props.filter((x) => x.mesh === 'character_head')) {
    const g = p.globalPos!;
    const b = new THREE.Box3();
    for (let i = 0; i < head.length; i += 3) {
      let x = head[i], y = head[i + 1], z = head[i + 2];
      if (p.xfRot) ({ x, y, z } = rotateBng(p.xfRot, x, y, z));
      b.expandByPoint(new THREE.Vector3(x + g[0], y + g[1], z + g[2]));
    }
    const c = b.getCenter(new THREE.Vector3());
    const n5 = v.nodes[p.idRef], n6 = v.nodes[p.idX];
    const mid = new THREE.Vector3((n5.x + n6.x) / 2, (n5.y + n6.y) / 2, (n5.z + n6.z) / 2);
    console.log(`${p.row.part.path.split('/').slice(-2, -1)}: head centre ${c.toArray().map((x) => x.toFixed(2))}, neck→head-node midpoint ${mid.toArray().map((x) => x.toFixed(2))}, distance ${(c.distanceTo(mid) * 100).toFixed(1)} cm`);
  }
});
