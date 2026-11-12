import { it, expect } from 'vitest';
import { loadVehicle } from './helpers';
import { analyzeSuspension } from '../src/core/analysis/suspension';
import { massReport } from '../src/core/analysis/debug';

const opts = { rigidThreshold: 1_000_000, partPattern: 'suspension|susp|hub|steer|knuckle|strut|coilover|shock|spring|swaybar|arm|axle|link|leaf|wishbone|trailing|spindle|upright|tierod|rack', travel: 0.08, steps: 9 };
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));

for (const model of ['etk800', 'covet', 'pickup', 'sbr', 'rockbouncer']) {
  it(`suspension ${model}`, async () => {
    const { veh } = await loadVehicle(model);
    const t0 = performance.now();
    const r = analyzeSuspension(veh!, opts, massReport(veh!).cog[2]);
    console.log(`\n== ${model}: free ${r.freeNodes} rigid ${r.rigidBeams} compliant ${r.compliantBeams} wb ${f(r.wheelbase)} cogH ${f(r.cogHeight)} residual ${(r.residual * 1000).toFixed(3)}mm  [${(performance.now() - t0).toFixed(0)} ms]`);
    for (const w of r.warnings) console.log('  !', w);
    for (const a of r.axles) {
      console.log(`  ${a.axle}: track ${f(a.track)} RC ${a.rollCenter ? f(a.rollCenter[1] * 1000, 0) + ' mm' : '—'}`);
      for (const c of a.corners) {
        console.log(`    ${c.corner.name}: camber ${f(c.camber)} toe ${f(c.toe)} caster ${f(c.caster)} KPI ${f(c.kpi)} scrub ${f(c.scrub && c.scrub * 1000, 0)}mm trail ${f(c.trail && c.trail * 1000, 0)}mm axis:${c.steerAxisSource} hub=${c.unsprungNodes} springs: ${c.springs.slice(0, 2).map((s) => `${s.kind} MR ${f(s.motionRatio)} k ${s.k}`).join('; ')}`);
        const cv = a.curves[c.corner.name];
        console.log(`      camber curve ${cv.camber.map((x) => f(x, 2)).join(' ')}`);
        console.log(`      toe curve    ${cv.toe.map((x) => f(x, 2)).join(' ')}`);
      }
      console.log(`    RC height curve (mm) ${a.rcCurve.height.map((x) => f(x * 1000, 0)).join(' ')}`);
    }
    if (r.steering) { const s = r.steering; const e = s.input.length - 1; console.log(`  steering: in=+1 L ${f(s.left[e])} R ${f(s.right[e])} ideal ${f(s.ideal[e])} | in=-1 L ${f(s.left[0])} R ${f(s.right[0])} ideal ${f(s.ideal[0])} | mid L ${f(s.left[25])} R ${f(s.right[25])} ack ${f(s.ackermannPct, 0)}%`); }
    console.log(`  anti-dive ${f(r.antiDive, 0)}% anti-squat ${f(r.antiSquat, 0)}%`);
    expect(r.axles.length).toBeGreaterThan(0);
  });
}
