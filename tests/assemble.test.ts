import { describe, it, expect } from 'vitest';
import { getVfs, loadJbeamDir, loadVehicle, summarize } from './helpers';

describe('parser on vanilla content', () => {
  it('parses every common + pickup jbeam without errors', async () => {
    const t0 = performance.now();
    const files = [...(await loadJbeamDir('vehicles/common')), ...(await loadJbeamDir('vehicles/pickup'))];
    const dt = performance.now() - t0;
    let bytes = 0;
    const bad: string[] = [];
    for (const f of files) {
      bytes += f.text.length;
      const errs = f.issues.filter((i) => i.sev === 'error');
      if (errs.length) bad.push(`${f.path}: ${errs[0].msg} @${errs[0].s}`);
    }
    console.log(`parsed ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB in ${dt.toFixed(0)} ms (incl. zip IO); files with errors: ${bad.length}`);
    for (const b of bad.slice(0, 10)) console.log('  ', b);
    expect(files.length).toBeGreaterThan(500);
  });
});

describe('assembly', () => {
  const cases: Array<[string, string | undefined]> = [
    ['pickup', undefined], ['pickup', 'd15_4wd_A.pc'], ['covet', undefined], ['etk800', undefined],
    ['sbr', undefined], ['us_semi', undefined], ['scintilla', undefined], ['utv', undefined], ['rockbouncer', undefined], ['picnic', undefined], ['etkk', undefined], ['euvan', undefined], ['fr04', undefined], ['muscle', undefined], ['ropelbe', undefined], ['miraggio', undefined],
  ];
  for (const [model, pc] of cases) {
    it(`assembles ${model} ${pc ?? '(defaults)'}`, async () => {
      const t0 = performance.now();
      const { veh } = await loadVehicle(model, pc);
      expect(veh).not.toBeNull();
      console.log(`${model} ${pc ?? ''}: ${summarize(veh!)} [${(performance.now() - t0).toFixed(0)} ms]`);
      const sample = veh!.issues.filter((i) => i.sev !== 'hint' && i.sev !== 'info').slice(0, 6);
      for (const s of sample) console.log('   ', s.sev, s.code, s.msg.slice(0, 160), s.part ?? '');
      expect(veh!.nodes.length).toBeGreaterThan(model === "ropelbe" ? 1 : 50);
    });
  }

  it('lists vehicles', async () => {
    const vfs = await getVfs();
    const list = await vfs.listVehicles();
    console.log('vehicles:', list.length, list.filter((v) => v.sources[0].kind !== 'game').map((v) => `${v.model}<${v.sources.map((s) => s.label).join('|')}>`).join(', '));
    expect(list.length).toBeGreaterThan(50);
  });
});
