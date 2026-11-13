import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { collectRails, collectSlides, closestOnRail, pointAtS, railPoints, offRailSlides } from '../src/core/jbeam/rails';

it('rail geometry', () => {
  const pts: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  const c = closestOnRail(pts, false, [0.5, 0.2, 0])!;
  expect(c.s).toBeCloseTo(0.5);
  expect(c.dist).toBeCloseTo(0.2);
  expect(pointAtS(pts, false, 1.5)).toEqual([1, 0.5, 0]);
  expect(pointAtS(pts, false, 9)).toEqual([1, 1, 0]);
  const loopPt = pointAtS(pts, true, 1 + 1 + Math.SQRT2 + 0.5);
  expect(loopPt[0]).toBeCloseTo(0.5);
});

it('reads vanilla rails and slidenodes', async () => {
  const { veh } = await loadVehicle('etk800');
  const v = veh!;
  const rails = collectRails(v);
  const slides = collectSlides(v);
  console.log(`etk800: ${rails.size} rails, ${slides.length} slidenodes, off-rail: ${offRailSlides(v).map((o) => `${v.nodes[o.slide.node].name} ${(o.dist * 1000).toFixed(1)}mm`).join(', ') || 'none'}`);
  expect(rails.size).toBeGreaterThan(0);
  const pos = new Float64Array(v.nodes.length * 3);
  v.nodes.forEach((n, i) => pos.set([n.x, n.y, n.z], i * 3));
  for (const s of slides.slice(0, 3)) {
    const r = rails.get(s.rail)!;
    const c = closestOnRail(railPoints(r, pos), r.looped, [pos[s.node * 3], pos[s.node * 3 + 1], pos[s.node * 3 + 2]])!;
    console.log(`  ${v.nodes[s.node].name} on ${s.rail}: s=${c.s.toFixed(3)} dist=${(c.dist * 1000).toFixed(2)}mm`);
  }
});

it('rails debug check flags off-rail slidenodes', async () => {
  const { runChecks } = await import('../src/core/analysis/debug');
  const { veh } = await loadVehicle('etk800');
  const f = runChecks(veh!, { shortBeam: 0.01, closeNodes: 0.001, minBeams: 3, mirrorTolerance: 0.002, suffixL: 'l', suffixR: 'r' }, new Set(['rails']));
  expect(f.length).toBeGreaterThan(0);
  expect(f.every((x) => x.check === 'rails')).toBe(true);
  expect(f.some((x) => x.fix === 'snapRail')).toBe(true);
});
