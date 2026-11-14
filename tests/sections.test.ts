import { expect, it } from 'vitest';
import { insertKeyAt, sectionValue, SECTION_BY_KEY, partValue, applyTextEdits, CURSOR } from '../src/core/jbeam/sections';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { parseSjson, toJs } from '../src/core/sjson';

const file = [
  '{',
  '"car_bumper_F": {',
  '    "information":{',
  '        "authors":"EditorNG contributors",',
  '        "name":"Front Bumper",',
  '    },',
  '    "slotType" : "car_bumper_F",',
  '    "nodes": [',
  '        ["id", "posX", "posY", "posZ"],',
  '        ["b1", 0, -2, 0.4],',
  '    ],',
  '    "beams": [',
  '        ["id1:", "id2:"],',
  '    ], // the beams',
  '},',
  '}',
  '',
].join('\n');

const part = () => parseJbeamFile('f', file).parts[0];
const val = (k: string) => (ind: string, unit: string, eol: string) => sectionValue(SECTION_BY_KEY.get(k)!, ind, unit, eol);

it('inserts a section before another one, cursor inside it', () => {
  const p = part();
  const before = [...p.sections.keys()].indexOf('beams');
  const keyIdx = p.node.keys.findIndex((k) => k.v === 'beams');
  const r = insertKeyAt(file, p.node, keyIdx, 'triangles', val('triangles'));
  const out = applyTextEdits(file, r.edits);
  expect(before).toBeGreaterThan(0);
  const j = toJs(parseSjson(out).root);
  expect(Object.keys(j.car_bumper_F)).toEqual(['information', 'slotType', 'nodes', 'triangles', 'beams']);
  expect(j.car_bumper_F.triangles).toEqual([['id1:', 'id2:', 'id3:']]);
  // the cursor sits on the blank line inside the new table, indented
  expect(out.slice(r.cursor! - 8, r.cursor!)).toBe('        ');
  expect(out.includes(CURSOR)).toBe(false);
});

it('appends at the end of the part, keeping a trailing comment', () => {
  const p = part();
  const r = insertKeyAt(file, p.node, null, 'flexbodies', val('flexbodies'));
  const out = applyTextEdits(file, r.edits);
  expect(out).toContain('], // the beams\n    "flexbodies": [');
  const j = toJs(parseSjson(out).root);
  expect(Object.keys(j.car_bumper_F).pop()).toBe('flexbodies');
});

it('adds the missing comma after the last value', () => {
  const t = '{\n"p": {\n    "slotType": "p"\n}\n}\n';
  const p = parseJbeamFile('f', t).parts[0];
  const out = applyTextEdits(t, insertKeyAt(t, p.node, null, 'nodes', val('nodes')).edits);
  expect(toJs(parseSjson(out).root).p.nodes).toEqual([['id', 'posX', 'posY', 'posZ']]);
  expect(parseSjson(out).issues?.length ?? 0).toBe(0);
});

it('one-line objects get the comma before the new entry', () => {
  const t = '{"p": {"slotType": "p"}}\n';
  const p = parseJbeamFile('f', t).parts[0];
  const out = applyTextEdits(t, insertKeyAt(t, p.node, null, 'beams', val('beams')).edits);
  expect(parseSjson(out).issues?.length ?? 0).toBe(0);
  expect(toJs(parseSjson(out).root).p.beams).toEqual([['id1:', 'id2:']]);
});

it('a new part after another one in the file', () => {
  const root = parseSjson(file).root as any;
  const value = (ind: string, unit: string, eol: string) => partValue({ authors: 'EditorNG contributors', name: 'Splitter', value: 120, slotType: 'car_splitter', sections: ['nodes', 'beams', 'flexbodies'] }, ind, unit, eol);
  const out = applyTextEdits(file, insertKeyAt(file, root, 1, 'car_splitter', value).edits);
  const parsed = parseJbeamFile('f', out);
  expect(parsed.parts.map((p) => p.name)).toEqual(['car_bumper_F', 'car_splitter']);
  const sp = parsed.parts[1];
  expect(sp.slotTypes).toEqual(['car_splitter']);
  expect(sp.info.name).toBe('Splitter');
  expect([...sp.sections.keys()]).toEqual(['information', 'slotType', 'nodes', 'beams', 'flexbodies']);
  expect(parsed.issues.filter((i) => i.sev === 'error')).toEqual([]);
});
