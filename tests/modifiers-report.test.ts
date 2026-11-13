import { it } from 'vitest';
import { loadVehicle } from './helpers';
import { modifierLeaks } from '../src/core/analysis/modifiers';

it.skipIf(!process.env.LEAK_REPORT)('leak breakdown', async () => {
  for (const model of ['etk800', 'pickup']) {
    const { veh } = await loadVehicle(model);
    const by = new Map<string, number>();
    for (const l of modifierLeaks(veh!)) by.set(`${l.section}.${l.key}`, (by.get(`${l.section}.${l.key}`) ?? 0) + 1);
    console.log(model, [...by].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k}:${n}`).join('  '));
  }
});
