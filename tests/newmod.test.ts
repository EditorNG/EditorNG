import { describe, expect, it } from 'vitest';
import {
  boxTriangles, copyPartText, emptyPartText, modNameError, newVehicleFiles, partNameFor, partTitleFor, pcText, slug, titleOf, vehicleIdError,
} from '../src/core/newmod';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { PartLibrary, resolveTree, buildVehicle } from '../src/core/jbeam/assemble';
import { normalizeConfig } from '../src/core/jbeam/config';
import { parseSjson, toJs } from '../src/core/sjson';
import { readDae, scanDae } from '../src/core/dae';
import { parseMaterialsJson } from '../src/core/materials';

const opts = { id: 'mybox', name: 'My Box', brand: '', type: 'Prop' as const, author: 'Me', template: 'box' as const };

describe('names', () => {
  it('slugs, titles and checks', () => {
    expect(slug('My Rally Box!')).toBe('my_rally_box');
    expect(slug('2CV')).toBe('v2cv');
    expect(titleOf('rally_bumper')).toBe('Rally Bumper');
    expect(modNameError('rally bumper')).toMatch(/no spaces/);
    expect(modNameError('rally_v1_2')).toMatch(/version/);
    expect(modNameError('v8_swap')).toBeNull();
    expect(modNameError('rally_bumper')).toBeNull();
    expect(vehicleIdError('MyBox')).toMatch(/Lowercase/);
    expect(vehicleIdError('common')).toMatch(/shared/);
  });
  it('suggests part names and titles from the slot', () => {
    expect(partNameFor('rally', 'etk800_bumper_F', 'etk800')).toBe('rally_bumper_F');
    expect(partNameFor('rally-pack', 'brakepad_F', 'etk800')).toBe('rally_pack_brakepad_F');
    expect(partNameFor('rally_bumper', 'etk800_bumper_F', 'etk800')).toBe('rally_bumper_F');
    expect(partNameFor('bumper', 'etk800_bumper_F', 'etk800')).toBe('bumper_F');
    expect(partTitleFor('rally_bumper', 'Front Bumper')).toBe('Rally Front Bumper');
  });
});

describe('new vehicle', () => {
  const files = newVehicleFiles(opts);
  const get = (p: string) => files.find((f) => f.path === p)!.text;

  it('writes the vanilla set of files', () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      'vehicles/mybox/base.pc', 'vehicles/mybox/info.json', 'vehicles/mybox/info_base.json',
      'vehicles/mybox/main.materials.json', 'vehicles/mybox/mybox.dae', 'vehicles/mybox/mybox.jbeam',
    ]);
    expect(toJs(parseSjson(get('vehicles/mybox/info.json')).root)).toEqual({ Author: 'Me', Name: 'My Box', Type: 'Prop', default_pc: 'base' });
    expect(toJs(parseSjson(get('vehicles/mybox/info_base.json')).root)).toEqual({ 'Config Type': 'Factory', Configuration: 'Base', Value: 1000 });
    expect(JSON.parse(get('vehicles/mybox/base.pc'))).toEqual({ format: 2, mainPartName: 'mybox', model: 'mybox', parts: { mybox_body: 'mybox_body' }, vars: {} });
  });

  it('assembles into a box the game can spawn', () => {
    const jf = parseJbeamFile('vehicles/mybox/mybox.jbeam', get('vehicles/mybox/mybox.jbeam'));
    expect(jf.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const lib = new PartLibrary([[jf]]);
    const cfg = normalizeConfig(JSON.parse(get('vehicles/mybox/base.pc')));
    const res = resolveTree(lib, cfg);
    const v = buildVehicle(res.parts, cfg, res.issues);
    expect(v.nodes).toHaveLength(8);
    expect(v.beams).toHaveLength(12 + 12 + 4);
    expect(v.tris).toHaveLength(12);
    expect(v.issues.filter((i) => i.sev === 'error' || i.sev === 'warning')).toEqual([]);
    expect(v.flexbodies.map((f) => f.mesh)).toEqual(['mybox_box']);
    expect(v.refNodes ?? null).not.toBeUndefined();
  });

  it('winds every triangle outwards', () => {
    const P: Record<string, number[]> = { b1r: [-0.5, -0.5, 0], b1l: [0.5, -0.5, 0], b2r: [-0.5, -0.5, 1], b2l: [0.5, -0.5, 1], b3r: [-0.5, 0.5, 0], b3l: [0.5, 0.5, 0], b4r: [-0.5, 0.5, 1], b4l: [0.5, 0.5, 1] };
    for (const [a, b, c] of boxTriangles()) {
      const u = P[b].map((x, i) => x - P[a][i]), w = P[c].map((x, i) => x - P[a][i]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const mid = [0, 1, 2].map((i) => (P[a][i] + P[b][i] + P[c][i]) / 3 - [0, 0, 0.5][i]);
      expect(n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2]).toBeGreaterThan(0);
    }
  });

  it('ships a mesh named like the flexbody, and its material', () => {
    const dae = get('vehicles/mybox/mybox.dae');
    expect(scanDae(dae).names).toContain('mybox_box');
    const m = readDae(dae).build('mybox_box');
    expect(m && m.pos.length / 9).toBe(12);
    const mats = parseMaterialsJson(get('vehicles/mybox/main.materials.json'), 'main.materials.json');
    expect(mats.map((x) => x.mapTo ?? x.name)).toContain('mybox_box');
  });

  it('empty template has the parts but nothing to spawn', () => {
    const t = newVehicleFiles({ ...opts, template: 'empty' });
    expect(t.map((f) => f.path)).not.toContain('vehicles/mybox/mybox.dae');
    const jf = parseJbeamFile('x.jbeam', t[0].text);
    expect(jf.parts.map((p) => p.name)).toEqual(['mybox', 'mybox_body']);
  });
});

describe('parts', () => {
  const vanilla = `{
"etk800_bumper_F": {
    "information":{
        "authors":"BeamNG",
        "name":"Front Bumper",
        "value":450,
    },
    "slotType" : "etk800_bumper_F",
    "nodes": [
         ["id", "posX", "posY", "posZ"],
         ["fb1r", -0.5, -2.0, 0.4],
    ],
},
"other": {"slotType":"x"},
}`;
  const def = parseJbeamFile('etk800_bumper_F.jbeam', vanilla).parts[0];

  it('copies a part under a new name, keeping its own text', () => {
    const t = copyPartText(vanilla, def, { name: 'rally_bumper_F', title: 'Rally Front Bumper', author: 'Me', slotType: 'etk800_bumper_F' });
    const p = parseJbeamFile('x.jbeam', t).parts;
    expect(p.map((x) => x.name)).toEqual(['rally_bumper_F']);
    expect(p[0].slotTypes).toEqual(['etk800_bumper_F']);
    expect(t).toContain('"name":"Rally Front Bumper"');
    expect(t).toContain('"authors":"Me"');
    expect(t).toContain('["fb1r", -0.5, -2.0, 0.4],');
    expect(t).not.toContain('"other"');
  });

  it('writes an empty part and a config', () => {
    const t = emptyPartText({ name: 'rally_bumper_F', title: 'Rally Front Bumper', author: 'Me', slotType: 'etk800_bumper_F' });
    expect(parseJbeamFile('x.jbeam', t).parts[0].slotTypes).toEqual(['etk800_bumper_F']);
    expect(JSON.parse(pcText('etk800', 'etk800', { a: 'b' }, { $x: 1 }))).toEqual({ format: 2, mainPartName: 'etk800', model: 'etk800', parts: { a: 'b' }, vars: { $x: 1 } });
  });
});
