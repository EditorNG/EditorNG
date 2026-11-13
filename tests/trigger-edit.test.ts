import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { placeTriggers, triggerValues, triggerFrame, type V3 } from '../src/core/jbeam/triggers';
import { applyNodeXform, getNodeXform, invertNodeXform } from '../src/core/jbeam/nodeTransform';

it('trigger values round-trip (translation, rotation, size)', async () => {
  const { veh } = await loadVehicle('etk800');
  const v = veh!;
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  const ts = placeTriggers(v, pos);
  expect(ts.length).toBeGreaterThan(5);
  let checked = 0;
  for (const t of ts) {
    const toRaw = (p: V3): V3 => {
      const r = invertNodeXform(getNodeXform(t.row.v), p[0], p[1], p[2]);
      return [r.x, r.y, r.z];
    };
    // rotate the box 30° about world Z around its origin, move it, and grow it
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const rz = (a: V3): V3 => [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]];
    const axes = { X: rz(t.frame.X), Y: rz(t.frame.Y), Z: rz(t.frame.Z) };
    const origin: V3 = [t.origin[0] + 0.05, t.origin[1] - 0.02, t.origin[2] + 0.01];
    const vals = triggerValues(v, pos, t, { origin, axes, size: [t.size[0] * 2, t.size[1], t.size[2]] }, toRaw);
    // re-place with the new values
    const row = { ...t.row, v: { ...t.row.v, ...vals } };
    const v2 = { ...v, triggers: v.triggers.map((r) => (r === t.row ? row : r)) };
    const t2 = placeTriggers(v2 as any, pos).find((x) => x.idx === t.idx)!;
    for (let k = 0; k < 3; k++) expect(t2.origin[k]).toBeCloseTo(origin[k], 5);
    if (t.type === 'box') {
      for (const ax of ['X', 'Y', 'Z'] as const) for (let k = 0; k < 3; k++) expect(t2.frame[ax][k]).toBeCloseTo(axes[ax][k], 3);
      expect(t2.size[0]).toBeCloseTo(t.size[0] * 2, 6);
    }
    checked++;
  }
  console.log(`checked ${checked} triggers`);
  void triggerFrame;
  void applyNodeXform;
});
