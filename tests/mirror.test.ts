import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { mirrorPart, insertPartAfter, swapSideTokens } from '../src/core/jbeam/mirror';
import { applyEdits } from '../src/core/jbeam/edit';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { toJs } from '../src/core/sjson';

it('swaps side tokens', () => {
  expect(swapSideTokens('etkk_fender_R')).toBe('etkk_fender_L');
  expect(swapSideTokens('door_FR_coupler')).toBe('door_FL_coupler');
  expect(swapSideTokens('wheel_RR')).toBe('wheel_RL');
  expect(swapSideTokens('Right Fender')).toBe('Left Fender');
  expect(swapSideTokens('pickup_frame')).toBe('pickup_frame');
});

for (const [model, partR] of [['pickup', 'pickup_door_R'], ['covet', 'covet_fender_R'], ['etk800', 'etk800_door_RR_sedan']] as const) {
  it(`mirrors ${partR} like the vanilla left part`, async () => {
    const { veh, files, lib } = await loadVehicle(model);
    const v = veh!;
    const def = lib.get(partR);
    if (!def) {
      console.log('skip, no part', partR);
      return;
    }
    const file = files.find((f) => f.path === def.file)!;
    const { text, report } = mirrorPart(file.text, def, {
      nodeX: (n) => {
        const i = v.nodeIndex.get(n);
        return i === undefined ? undefined : v.nodes[i].x;
      },
      nodeExists: (n) => v.nodeIndex.has(n),
      meshExists: () => true,
      partExists: (n) => !!lib.get(n),
      suffixL: 'l', suffixR: 'r', centerTol: 0.002,
    });
    console.log(partR, '->', report.newName, JSON.stringify({ ...report, refsKept: report.refsKept.slice(0, 5), meshesSwapped: report.meshesSwapped.slice(0, 3) }));
    // parse the generated part on its own
    const parsed = parseJbeamFile('m.jbeam', '{' + text + '}');
    expect(parsed.issues.filter((i) => i.sev === 'error')).toEqual([]);
    const mine = parsed.parts[0];
    const real = lib.get(report.newName);
    if (!real) return;
    // compare node sets and raw positions with the real left part
    const rows = (p: any) => {
      const sec = p.sections.get('nodes');
      const out = new Map<string, number[]>();
      if (!sec || sec.k !== 'arr') return out;
      for (const r of sec.items.slice(1)) if (r.k === 'arr' && r.items[0]?.k === 'str') out.set(r.items[0].v, r.items.slice(1, 4).map((c: any) => toJs(c)));
      return out;
    };
    const a = rows(mine), b = rows(real);
    let same = 0, close = 0;
    for (const [n, pos] of a) {
      const q = b.get(n);
      if (!q) continue;
      same++;
      if (pos.every((x, k) => typeof x === 'number' && Math.abs(x - q[k]) < 0.005)) close++;
    }
    console.log(`  nodes: generated ${a.size}, vanilla ${b.size}, same names ${same}, same position ${close}`);
    expect(same).toBeGreaterThan(b.size * 0.8);
    // insertion keeps the file valid
    const out = applyEdits(file.text, insertPartAfter(file.text, def, text));
    const pf = parseJbeamFile(file.path, out);
    expect(pf.issues.filter((i) => i.sev === 'error')).toEqual([]);
    expect(pf.parts.filter((p) => p.name === report.newName).length).toBeGreaterThan(0);
  });
}
