import { expect, it } from 'vitest';
import { otherSideRows } from '../src/core/analysis/debug';

// a minimal assembled vehicle: node owners and the rows that define beams / triangles
const row = (part: string, section: string, s = 0) => ({ part: { def: { name: part } }, src: { section, file: 'f.jbeam', node: { s, e: s + 10 } } });
const parts = ['skirt_R', 'skirt_L', 'seat_FL', 'seat_FR', 'body', 'rollcage'];
const nodes: any[] = [];
const node = (name: string, part: string) => (nodes.push({ name, row: row(part, 'nodes') }), nodes.length - 1);
const r1 = node('sk1r', 'skirt_R'), r2 = node('sk2r', 'skirt_R'), r3 = node('sk3r', 'skirt_R');
const l1 = node('sk1l', 'skirt_L'), l2 = node('sk2l', 'skirt_L'), l3 = node('sk3l', 'skirt_L');
const sfl = node('s1l', 'seat_FL'), sfr = node('s1r', 'seat_FR');
const b1 = node('b1', 'body'), b2 = node('b2', 'body');

const v = {
  nodes,
  partsByName: new Map(parts.map((p) => [p, {}])) as any,
  beams: [
    { a: r1, b: r2, row: row('skirt_R', 'beams') }, // own nodes: fine
    { a: r1, b: b1, row: row('skirt_R', 'beams') }, // to the body: fine
    { a: sfl, b: sfr, row: row('seat_FL', 'beams') }, // damper between both seats: fine
    { a: b1, b: b2, row: row('rollcage', 'beams') }, // a cage on body nodes: fine (body is not its mirror)
    { a: l1, b: l2, row: row('skirt_R', 'beams', 50) }, // only the left skirt's nodes: reported
  ] as any,
  tris: [
    { a: r1, b: r2, c: r3, row: row('skirt_R', 'triangles') },
    { a: l1, b: l2, c: l3, row: row('skirt_R', 'triangles', 90) }, // reported
    { a: l2, b: l3, c: l1, row: row('skirt_R', 'triangles', 120) }, // reported, same group
    { a: r1, b: r2, c: r3, row: row('skirt_L', 'triangles', 200) }, // the mirror mistake on the left: reported
  ] as any,
};

it('reports only elements made entirely of the other side part nodes', () => {
  const f = otherSideRows(v);
  expect(f.map((x) => `${x.part}>${x.section}:${x.kind}x${x.idx.length}->${x.twin}`).sort()).toEqual([
    'skirt_L>triangles:trix1->skirt_R',
    'skirt_R>beams:beamx1->skirt_L',
    'skirt_R>triangles:trix2->skirt_L',
  ]);
  const t = f.find((x) => x.part === 'skirt_R' && x.section === 'triangles')!;
  expect(t.s).toBe(90); // jumps to the first offending row
});
