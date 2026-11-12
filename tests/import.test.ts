import { it, expect } from 'vitest';
import fs from 'node:fs';
import { planImport, parseObj } from '../src/core/import/mesh';

const opts = { prefix: 'b', start: 1, suffixL: 'l', suffixR: 'r', centerTol: 0.002, mergeTol: 0.001, makeBeams: true, makeTris: true, order: 'front-to-back' as const, groupPrefix: false };

it.skipIf(!process.env.EDITORNG_TEST_JSON)('plans a blender cube import', () => {
  const p = process.env.EDITORNG_TEST_JSON!;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const plan = planImport(data.objects.map((o: any) => ({ name: o.name, verts: o.verts, edges: o.edges, tris: o.tris })), [], new Set(), new Set(), opts);
  console.log(plan.newNodes.map((n) => `${n.name}(${n.x},${n.y},${n.z})`).join(' '));
  console.log('beams', plan.beams.length, 'tris', plan.tris.length);
  expect(plan.newNodes.length).toBe(8);
  expect(plan.beams.length).toBe(12);
  expect(plan.tris.length).toBe(12);
  // mirror twins share numbers
  const nums = plan.newNodes.map((n) => n.name.replace(/[lr]+$/, ''));
  expect(new Set(nums).size).toBe(4);
  // re-import keeps names and adds nothing
  const plan2 = planImport(data.objects.map((o: any) => ({ name: o.name, verts: o.verts, edges: o.edges, tris: o.tris })), plan.newNodes, new Set(plan.beams.map(([a, b]) => (a < b ? a + '\u0001' + b : b + '\u0001' + a))), new Set(plan.tris.map((t) => [...t].sort().join('\u0001'))), opts);
  expect(plan2.newNodes.length).toBe(0);
  expect(plan2.beams.length).toBe(0);
  expect(plan2.matched).toBe(8);
});

it('parses OBJ with Y-up conversion', () => {
  const obj = 'o q\nv 1 2 3\nv 0 0 0\nv 1 0 0\nf 1 2 3\nl 2 3\n';
  const m = parseObj(obj, 'y-up');
  expect(m[0].verts.slice(0, 3)).toEqual([1, -3, 2]);
  expect(m[0].tris.length).toBe(3);
});
