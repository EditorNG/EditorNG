import { it, expect, describe } from 'vitest';
import { loadJbeamDir, loadVehicle } from './helpers';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { PartLibrary, assembleVehicle } from '../src/core/jbeam/assemble';
import { applyEdits, insertRows, deleteNodes, findNodeTokens, fmtRow, DEFAULT_HEADERS, insertKey } from '../src/core/jbeam/edit';
import { triggerRow, triggerLinkRows, bulbSlotRow, occupantSlotRow, wheelRow, wheelModifierRows, wheelNodes } from '../src/core/jbeam/generators';
import type { JFile } from '../src/core/jbeam/types';

async function picnic() {
  const { files } = await loadVehicle('picnic');
  const common = await loadJbeamDir('vehicles/common');
  const body = files.find((f) => f.path.endsWith('picnic_body.jbeam'))!;
  return { files, common, body };
}

function reassemble(files: JFile[], common: JFile[], path: string, text: string) {
  const nf = parseJbeamFile(path, text);
  const own = files.map((f) => (f.path === path ? nf : f));
  return { veh: assembleVehicle(new PartLibrary([own, common]), {})!, file: nf };
}

describe('generated rows survive a round trip through the loader', () => {
  it('trigger + link + multi-line bulb slot', async () => {
    const { files, common, body } = await picnic();
    const part = body.parts.find((p) => p.name === 'picnic_body')!;
    const v0 = assembleVehicle(new PartLibrary([files, common]), {})!;
    const ns = v0.nodes.filter((n) => n.row.part.def.name === 'picnic_body').slice(0, 3).map((n) => n.name);
    const spec = { id: 'test_trig', idRef: ns[0], idX: ns[1], idY: ns[2], type: 'sphere' as const, size: { x: 0.02, y: 0, z: 0 }, pos: { x: 0.3, y: -0.5, z: 0.9 }, action: 'common:toggle_headlights' };
    let text = body.text;
    const edits = [
      ...insertRows(text, part, 'triggers2', DEFAULT_HEADERS.triggers2, [triggerRow(spec)]),
      ...insertRows(text, part, 'triggerEventLinks2', DEFAULT_HEADERS.triggerEventLinks2, triggerLinkRows(spec)),
    ];
    text = applyEdits(text, edits);
    let r = reassemble(files, common, body.path, text);
    expect(r.file.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const trig = (r.veh.tables.get('triggers2') ?? []).find((x) => x.v.id === 'test_trig');
    expect(trig).toBeTruthy();
    expect(trig!.v.baseTranslationGlobal).toEqual({ x: 0.3, y: -0.5, z: 0.9 });
    expect((r.veh.tables.get('triggerEventLinks2') ?? []).some((x) => x.v.inputAction === 'common:toggle_headlights')).toBe(true);

    // bulb slot: picnic_body uses legacy "slots", so test on a synthetic slots2 part instead
    const src = '{\n    "lamp": {\n        "slotType": "lamp",\n        "slots2": [\n            ["name", "allowTypes", "denyTypes", "default", "description"],\n        ],\n    },\n}\n';
    const lf = parseJbeamFile('lamp.jbeam', src);
    const bulb = bulbSlotRow({ slotName: 'test_bulb', bulb: 'incandescent_white_5W', description: 'Test', electric: 'lowhighbeam', nodeRef: ns[0], nodeX: ns[1], nodeY: ns[2], deformGroup: '', pos: { x: 0, y: 1, z: 1 }, rot: { x: 90, y: 0, z: 0 }, shadow: true });
    const lt = applyEdits(src, insertRows(src, lf.parts[0], 'slots2', DEFAULT_HEADERS.slots2, [bulb]));
    const lf2 = parseJbeamFile('lamp.jbeam', lt);
    expect(lf2.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const slot = lf2.parts[0].slots.find((s) => s.name === 'test_bulb');
    expect(slot?.variables?.$posZ).toBe(1);
    expect(slot?.allowTypes).toEqual(['incandescent_white_5W']);
    const i = lt.indexOf('"test_bulb"');
    const chunk = lt.slice(i, lt.indexOf('}]', i));
    for (const line of chunk.split(/\r?\n/).slice(1)) expect(/^\s{8,}/.test(line)).toBe(true);
    console.log(lt);
  });

  it('occupant slot and pressure wheels', async () => {
    const { files, common, body } = await picnic();
    const part = body.parts.find((p) => p.name === 'picnic_body')!;
    const w = { name: 'FR', center: { x: -0.78, y: -1.46, z: 0.46 }, prefix: 'tw1', hubWidth: 0.14, nodeArm: '', radius: 0.36, hubRadius: 0.23, tireWidth: 0.24, numRays: 16, pressurePSI: 32, createNodes: true };
    let text = body.text;
    const edits = [
      ...insertRows(text, part, 'nodes', DEFAULT_HEADERS.nodes, wheelNodes(w).map((n) => fmtRow([n.name, n.x, n.y, n.z]))),
      ...insertRows(text, part, 'pressureWheels', DEFAULT_HEADERS.pressureWheels, [...wheelModifierRows(w), wheelRow(w)]),
    ];
    text = applyEdits(text, edits);
    const r = reassemble(files, common, body.path, text);
    expect(r.file.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const wheel = r.veh.wheels.find((x) => x.name === 'FR' && r.veh.nodes[x.n1].name === 'tw1rr');
    expect(wheel).toBeTruthy();
    expect(wheel!.radius).toBe(0.36);

    const occ = occupantSlotRow({ slotName: 'seat_occupant_FL', description: 'FL', seatID: 'FL', highlightMesh: '', nodeMove: { x: 0.4, y: 0.1, z: 0.4 }, recline: -24, attach: { FL: 'a', FR: 'b', RL: 'c', RR: 'd', TL: 'e', TR: 'f' }, rigidifier: 'sf4l', dragCoef: 1, noSelfCol: false });
    const src = '{"seat": {"slotType": "seat", "slots2": [["name", "allowTypes", "denyTypes", "default", "description"]]}}';
    const sf = parseJbeamFile('s.jbeam', src);
    const st = applyEdits(src, insertRows(src, sf.parts[0], 'slots2', DEFAULT_HEADERS.slots2, [occ]));
    const sf2 = parseJbeamFile('s.jbeam', st);
    expect(sf2.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const os = sf2.parts[0].slots[0];
    expect(os.name).toBe('seat_occupant_FL');
    expect(os.options.nodeRotate1).toEqual({ x: -24, y: 0, z: 0 });
    expect(os.variables?.$occupant_camPitch).toBe(24);
  });

  it('creates a missing section and deletes rows cleanly', () => {
    const src = '{\n  "p": {\n    "slotType": "main",\n    "nodes": [\n      ["id", "posX", "posY", "posZ"],\n      ["a", 0, 0, 0],\n      ["b", 1, 0, 0], // keep me\n      ["c", 0, 1, 0],\n    ],\n  },\n}\n';
    const f = parseJbeamFile('t.jbeam', src);
    const t1 = applyEdits(src, insertRows(src, f.parts[0], 'beams', DEFAULT_HEADERS.beams, [fmtRow(['a', 'b']), fmtRow(['b', 'c'])]));
    const f1 = parseJbeamFile('t.jbeam', t1);
    expect(f1.issues).toEqual([]);
    expect(f1.parts[0].sections.has('beams')).toBe(true);
    const rows = (f1.parts[0].sections.get('nodes') as any).items;
    const t2 = applyEdits(t1, deleteNodes(t1, [rows[1]]));
    expect(t2).not.toContain('["a", 0, 0, 0]');
    expect(t2).toContain('// keep me');
    expect(parseJbeamFile('t.jbeam', t2).issues).toEqual([]);
    const t3 = applyEdits(t1, insertKey(t1, f1.parts[0].node, 'occupantSystem', () => '{ "enabled": true, "version": 1 }'));
    expect(parseJbeamFile('t.jbeam', t3).parts[0].sections.has('occupantSystem')).toBe(true);
    console.log(t3);
  });

  it('finds every reference of a node for renaming', async () => {
    const { veh } = await loadVehicle('pickup');
    let count = 0;
    for (const p of veh!.parts) count += findNodeTokens(p.def, 'fw1r').length;
    console.log('references to fw1r:', count);
    expect(count).toBeGreaterThan(5);
  });
});
