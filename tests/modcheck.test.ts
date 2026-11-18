import { afterAll, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanMod } from '../src/main/modcheck';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modcheck-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string | Buffer = 'x') => {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const mod = 'user/mods/unpacked/my_mod';
put(`${mod}/vehicles/car/a_b.color.png`, Buffer.alloc(5000));
put(`${mod}/vehicles/car/a_b.color.dds`, Buffer.alloc(1000));
put(`${mod}/vehicles/car/c_b.color.png`, Buffer.alloc(4000));
put('user/temp/vehicles/car/c_b.color.dds', Buffer.alloc(800));
put(`${mod}/vehicles/car/d_n.normal.png`, Buffer.alloc(3000));
put(`${mod}/vehicles/car/unused_m.data.dds`, Buffer.alloc(100));
put(`${mod}/vehicles/car/notes.txt`, 'todo');
put(`${mod}/vehicles/car/car_extra.jbeam`, '{"car_bumper":{"slotType":"car_bumper"},"other_part":{"slotType":"x"}}');
put(`${mod}/vehicles/car/main.materials.json`, JSON.stringify({
  car_paint: { name: 'car_paint', class: 'Material', Stages: [{ baseColorMap: '/vehicles/car/a_b.color.png', normalMap: 'vehicles/car/d_n.normal.png' }, { baseColorMap: 'vehicles/car/c_b.color.png' }, { baseColorMap: 'vehicles/car/gone_b.color.png' }] },
  glass: { name: 'glass', class: 'Material', Stages: [{}] },
}));

it('sorts what to fix before release and what makes the zip bigger', async () => {
  const r = await scanMod(path.join(root, ...mod.split('/')), {
    userDir: path.join(root, 'user'),
    gamePaths: async () => new Set(['vehicles/common/glass_b.color.dds']),
    vanillaParts: async () => new Map([['car_bumper', 'vehicles/car/car_bumper.jbeam'], ['other_part', 'vehicles/truck/truck.jbeam']]),
    vanillaMaterials: async () => new Map([['glass', 'vehicles/common/main.materials.json']]),
  });
  const find = (re: RegExp) => r.issues.filter((i) => re.test(i.msg + ' ' + (i.file ?? '')));
  // PNG next to its DDS: left out
  expect(r.exclude).toContain('vehicles/car/a_b.color.png');
  // cooked DDS waiting in temp/
  const cook = find(/c_b\.color\.png/)[0];
  expect(cook.fix?.kind).toBe('copyDds');
  expect(cook.cat).toBe('size');
  // not converted at all
  expect(find(/Not converted.*d_n\.normal\.png/).length).toBe(1);
  // leftovers left out
  expect(r.exclude).toContain('vehicles/car/notes.txt');
  // part clash only within the same vehicle folder (or common)
  expect(find(/"car_bumper"/).length).toBe(1);
  expect(find(/"other_part"/).length).toBe(0);
  // material clash with the game
  expect(find(/Material "glass"/).length).toBe(1);
  // a material names a texture that exists nowhere
  expect(find(/gone_b\.color/).length).toBe(1);
  // a material texture nothing uses
  expect(find(/No material.*unused_m\.data\.dds/).length).toBe(1);
});
