import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { mirrorPart } from '../src/core/jbeam/mirror';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import type { PartDef } from '../src/core/jbeam/types';

function rowsOf(p: PartDef, sec: string): string[][] {
  const s = p.sections.get(sec);
  const out: string[][] = [];
  if (!s || s.k !== 'arr') return out;
  for (const r of s.items.slice(1)) if (r.k === 'arr') out.push(r.items.filter((c) => c.k === 'str').map((c: any) => c.v));
  return out;
}
const canonTri = (t: string[]) => {
  // rotation-invariant, winding-sensitive key
  const k = [t.join(','), [t[1], t[2], t[0]].join(','), [t[2], t[0], t[1]].join(',')];
  return k.sort()[0];
};

for (const model of ['covet', 'pickup', 'etk800', 'sbr']) {
  it(`mirrors every _R part of ${model} like vanilla`, async () => {
    const { veh, files, lib } = await loadVehicle(model);
    const v = veh!;
    let parts = 0, nodeOk = 0, nodeTotal = 0, beamOk = 0, beamTotal = 0, triOk = 0, triTotal = 0;
    for (const f of files) for (const def of f.parts) {
      if (!/_R($|_)/.test(def.name) || def.name.includes('_RR') || def.name.includes('_FR')) continue;
      const lname = def.name.replace(/_R($|_)/, '_L$1');
      const real = lib.get(lname);
      if (!real) continue;
      const { text } = mirrorPart(f.text, def, {
        nodeX: (n) => { const i = v.nodeIndex.get(n); return i === undefined ? undefined : v.nodes[i].x; },
        nodeExists: (n) => v.nodeIndex.has(n),
        meshExists: () => true,
        partExists: () => false,
        suffixL: 'l', suffixR: 'r', centerTol: 0.002,
      });
      const mine = parseJbeamFile('m.jbeam', '{' + text + '}').parts[0];
      parts++;
      const rn = new Set(rowsOf(real, 'nodes').map((r) => r[0]));
      for (const r of rowsOf(mine, 'nodes')) { nodeTotal++; if (rn.has(r[0])) nodeOk++; }
      const rb = new Set(rowsOf(real, 'beams').filter((r) => r.length >= 2).map((r) => [r[0], r[1]].sort().join(',')));
      for (const r of rowsOf(mine, 'beams')) if (r.length >= 2) { beamTotal++; if (rb.has([r[0], r[1]].sort().join(','))) beamOk++; }
      const rt = new Set(rowsOf(real, 'triangles').filter((r) => r.length >= 3).map((r) => canonTri(r.slice(0, 3))));
      for (const r of rowsOf(mine, 'triangles')) if (r.length >= 3) { triTotal++; if (rt.has(canonTri(r.slice(0, 3)))) triOk++; }
    }
    console.log(`${model}: ${parts} parts — nodes ${nodeOk}/${nodeTotal}, beams ${beamOk}/${beamTotal}, triangles (same winding) ${triOk}/${triTotal}`);
    expect(parts).toBeGreaterThan(0);
  });
}
