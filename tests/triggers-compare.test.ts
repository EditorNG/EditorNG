import { it } from 'vitest';
import * as THREE from 'three';
import { loadVehicle } from './helpers';
import { placeTriggers, triggerRows } from '../src/core/jbeam/triggers';

/** The previous (wrong) placement, kept here only to measure the improvement. */
function oldCentres(v: any, pos: Float64Array): number[][] {
  const out: number[][] = [];
  const num = (x: any, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  for (const row of v.tables.get('triggers2') ?? []) {
    const r = row.v;
    const ri = v.nodeIndex.get(String(r['idRef:'])), xi = v.nodeIndex.get(String(r['idX:'])), yi = v.nodeIndex.get(String(r['idY:']));
    if (ri === undefined || xi === undefined || yi === undefined) continue;
    const P = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const ref = P(ri);
    const X0 = P(xi).sub(ref).normalize();
    const Y0 = new THREE.Vector3().crossVectors(P(yi).sub(ref), X0).normalize();
    const Z0 = new THREE.Vector3().crossVectors(X0, Y0).normalize();
    let axes = { X: X0, Y: Y0, Z: Z0 };
    const br = r.baseRotation;
    if (br && typeof br === 'object') {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(num(br.x, 0) * Math.PI / 180, num(br.y, 0) * Math.PI / 180, num(br.z, 0) * Math.PI / 180, 'XYZ'));
      const m = new THREE.Matrix4().makeBasis(axes.X, axes.Y, axes.Z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q));
      const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
      m.extractBasis(X, Y, Z);
      axes = { X, Y, Z };
    }
    const g = r.baseTranslationGlobal;
    const bt = r.baseTranslation ?? {};
    const corner = g && typeof g === 'object' ? new THREE.Vector3(num(g.x, 0), num(g.y, 0), num(g.z, 0)) : ref.clone().addScaledVector(axes.X, num(bt.x, 0)).addScaledVector(axes.Y, num(bt.y, 0)).addScaledVector(axes.Z, num(bt.z, 0));
    const size = typeof r.size === 'number' ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(num(r.size?.x, 0.05), num(r.size?.y, 0.05), num(r.size?.z, 0.05));
    const c = corner.clone().addScaledVector(axes.X, size.x / 2).addScaledVector(axes.Y, size.y / 2).addScaledVector(axes.Z, size.z / 2);
    out.push([c.x, c.y, c.z]);
  }
  return out;
}

function nearestNode(v: any, c: number[]): number {
  let best = Infinity;
  for (const n of v.nodes) best = Math.min(best, Math.hypot(n.x - c[0], n.y - c[1], n.z - c[2]));
  return best;
}

for (const model of ['pickup', 'covet', 'etk800', 'moonhawk', 'bastion', 'etkc', 'legran', 'sbr', 'vivace', 'van']) {
  it(`old vs new trigger placement on ${model}`, async () => {
    const { veh } = await loadVehicle(model);
    const v = veh!;
    const pos = new Float64Array(v.nodes.length * 3);
    v.nodes.forEach((n: any, i: number) => pos.set([n.x, n.y, n.z], i * 3));
    const nw = placeTriggers(v, pos).map((t) => nearestNode(v, t.center));
    const old = oldCentres(v, pos).map((c) => nearestNode(v, c));
    const stat = (a: number[]) => `median ${(a.sort((x, y) => x - y)[Math.floor(a.length / 2)] * 100).toFixed(1)} cm, >20cm: ${a.filter((x) => x > 0.2).length}/${a.length}`;
    console.log(`${model.padEnd(9)} triggers ${triggerRows(v).length} | old: ${stat(old)} | new: ${stat(nw)}`);
  });
}
