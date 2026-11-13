import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { PartLibrary, assembleVehicle } from '../src/core/jbeam/assemble';
import { modifierLeaks } from '../src/core/analysis/modifiers';

const SRC = `{
"m_main": {
  "slotType": "main",
  "slots2": [["name", "allowTypes", "denyTypes", "default", "description"], ["m_a", ["m_a"], [], "m_a", "A"], ["m_b", ["m_b"], [], "m_b", "B"]],
  "nodes": [["id", "posX", "posY", "posZ"], ["n0", 0, 0, 0], ["n1", 1, 0, 0]],
  "beams": [["id1:", "id2:"], ["n0", "n1"]]
},
"m_a": {
  "slotType": "m_a",
  "nodes": [["id", "posX", "posY", "posZ"], ["a0", 0, 1, 0]],
  "beams": [
    ["id1:", "id2:"],
    {"beamSpring": 9000, "deformGroup": "door"},
    ["a0", "n0"],
    {"deformGroup": ""}
  ]
},
"m_b": {
  "slotType": "m_b",
  "nodes": [["id", "posX", "posY", "posZ"], ["b0", 0, 2, 0]],
  "beams": [["id1:", "id2:"], ["b0", "n1"], ["b0", "a0"]]
}
}`;

it('tracks modifier origins and finds leaks into other parts', () => {
  const f = parseJbeamFile('vehicles/m/m.jbeam', SRC);
  const lib = new PartLibrary([[f]]);
  const v = assembleVehicle(lib, { model: 'm', parts: {}, vars: {} } as any)!;
  expect(v).toBeTruthy();
  const beamB = v.beams.find((b) => v.nodes[b.a].name === 'b0' && v.nodes[b.b].name === 'n1')!;
  // beamSpring set in m_a was never reset: it reaches m_b's beams
  expect(beamB.row.v.beamSpring).toBe(9000);
  expect(beamB.row.mods?.beamSpring?.part).toBe('m_a');
  const leaks = modifierLeaks(v);
  expect(leaks.map((l) => l.key)).toEqual(['beamSpring']);
  expect([...leaks[0].into.keys()]).toEqual(['m_b']);
  expect(leaks[0].into.get('m_b')!.length).toBe(2);
  // deformGroup was reset with "" → no leak
  expect(leaks.some((l) => l.key === 'deformGroup')).toBe(false);
});

it('vanilla leak report runs', async () => {
  for (const model of ['etk800', 'pickup']) {
    const { veh } = await loadVehicle(model);
    const leaks = modifierLeaks(veh!);
    console.log(`${model}: ${leaks.length} leaking modifiers` + (leaks.length ? ' e.g. ' + leaks.slice(0, 3).map((l) => `${l.section}.${l.key}=${l.value} ${l.origin.part}→${[...l.into.keys()].slice(0, 2).join(',')}`).join('; ') : ''));
    expect(Array.isArray(leaks)).toBe(true);
  }
});
