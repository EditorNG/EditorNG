import { expect, it } from 'vitest';
import { scoreGroups } from '../src/core/flexfit';

it('suggests the groups under the mesh, not the far ones', () => {
  const nodes = [
    ...[0, 0.2, 0.4].map((y) => ({ x: 0.8, y: -2 + y, z: 0.5, groups: ['bumper_F'] })),
    ...[0, 0.2].map((y) => ({ x: 0.8, y: -1.6 + y, z: 0.6, groups: ['fender_L', 'body'] })),
    { x: 0, y: 2, z: 0.5, groups: ['tailgate'] },
    { x: 0.5, y: 0, z: 0.5, groups: [] },
  ];
  // a mesh spanning the bumper nodes, a little of the fender
  const pos: number[] = [];
  for (let i = 0; i < 100; i++) pos.push(0.8, -2 + (i / 100) * 0.5, 0.5);
  const r = scoreGroups(pos, nodes);
  const sug = r.filter((s) => s.suggested).map((s) => s.group);
  expect(sug[0]).toBe('bumper_F');
  expect(sug).not.toContain('tailgate');
  expect(r.find((s) => s.group === 'bumper_F')!.nodes).toBe(3);
});

it('ignores vertices far from every node', () => {
  const r = scoreGroups([10, 10, 10], [{ x: 0, y: 0, z: 0, groups: ['a'] }]);
  expect(r).toEqual([]);
});
