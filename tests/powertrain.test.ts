import { expect, it } from 'vitest';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { PartLibrary, resolveTree, buildVehicle } from '../src/core/jbeam/assemble';
import { readPowertrain, roadSpeed, kW, engineCurves, createCurve, baseFor, peak } from '../src/core/analysis/powertrain';

const text = `{
"car": {
  "slotType": "main",
  "slots": [["type","default","description"], ["car_engine","car_engine","Engine"], ["car_radiator","car_radiator","Radiator"]],
  "nodes": [["id","posX","posY","posZ"], ["a",0,0,0], ["b",0,1,0]],
  "powertrain": [
    ["type", "name", "inputName", "inputIndex"],
    ["differential", "differential_R", "gearbox", 1, {"diffType":"lsd", "gearRatio": 3.0}]
  ]
},
"car_engine": {
  "slotType": "car_engine",
  "powertrain": [
    ["type", "name", "inputName", "inputIndex"],
    ["combustionEngine", "mainEngine", "dummy", 0],
    ["manualGearbox", "gearbox", "mainEngine", 1]
  ],
  "mainEngine": {
    "torque": [["rpm", "torque"], [0, 0], [1000, 172], [4000, "$=200*1.08"], [7000, 180]],
    "idleRPM": 850,
    "maxRPM": 7200
  },
  "gearbox": { "gearRatios": [-2.33, 0, 2.8, 1.54, 1.0, 0.7] }
},
"car_radiator": {
  "slotType": "car_radiator",
  "slots": [["type","default","description"], ["car_ecu","car_ecu","ECU"]],
  "mainEngine": { "radiatorArea": 0.3, "idleRPM": 900 }
},
"car_ecu": {
  "slotType": "car_ecu",
  "variables": [["name","type","unit","category","default","min","max","title","description"], ["$revLimiter","range","rpm","Engine",6800,5000,7500,"Limiter",""]],
  "mainEngine": { "$+maxRPM": 300, "$*idleRPM": 1.1, "revLimiterRPM": "$revLimiter" }
}
}`;

it('reads the torque curve, the gear ratios and the final drive, with what can be edited', () => {
  const jf = parseJbeamFile('vehicles/car/car.jbeam', text);
  const lib = new PartLibrary([[jf]]);
  const res = resolveTree(lib, {});
  const v = buildVehicle(res.parts, {}, res.issues);
  const pt = readPowertrain(v);
  expect(pt.engines).toHaveLength(1);
  const e = pt.engines[0];
  expect(e.points.map((p) => p.rpm.value)).toEqual([0, 1000, 4000, 7000]);
  expect(e.points[2].torque.node).toBeNull(); // an expression: read-only
  expect(e.points[1].torque.node).not.toBeNull();
  // keys merge across parts: the torque stays with the engine, idle comes from the later radiator part
  expect(e.part).toBe('car_engine');
  // the ECU modifies maxRPM / idleRPM ($+, $*) and sets the limiter from a tuning variable
  expect(e.idleRPM?.value).toBeCloseTo(990);
  expect(e.idleRPM?.sources.map((x) => [x.part, x.op, x.cell.value])).toEqual([['car_radiator', '=', 900], ['car_ecu', '*', 1.1]]);
  expect(e.maxRPM?.value).toBe(7500);
  expect(e.maxRPM?.sources.map((x) => x.op)).toEqual(['=', '+']);
  expect(baseFor(e.maxRPM!, 8000)).toBe(7700);
  expect(e.revLimiterRPM?.value).toBe(6800);
  expect(e.revLimiterRPM?.sources[0].cell.varName).toBe('$revLimiter');
  expect(pt.gearboxes[0].ratios.map((r) => r.value)).toEqual([-2.33, 0, 2.8, 1.54, 1.0, 0.7]);
  expect(pt.finalDrives[0].ratio.value).toBe(3);
  expect(pt.finalDrives[0].ratio.node).not.toBeNull();
  // 7000 rpm in 1:1 with a 3.0 final drive and 0.3 m wheels: 7000/3 rev/min * 2π*0.3 m = 263.9 km/h
  expect(roadSpeed(7000, 1, 3, 0.3)).toBeCloseTo(263.9, 0);
  expect(kW(200, 5000)).toBeCloseTo(104.7, 1);
});

it('builds curves like the game: Catmull-Rom table, modifier tables, limiter, friction, supercharger', () => {
  // two points: a straight line; more: Catmull-Rom through every point
  const lin = createCurve([[0, 0], [10, 100]])!;
  expect(lin[5]).toBeCloseTo(50);
  const cr = createCurve([[0, 0], [1000, 100], [2000, 100], [3000, 0]])!;
  expect(cr[1000]).toBeCloseTo(100);
  expect(cr[1500]).toBeGreaterThan(100); // overshoot between equal points, as in the game
  const eng = {
    torque: [['rpm', 'torque'], [0, 0], [1000, 200], [4000, 300], [7000, 200]],
    torqueModIntake: [['rpm', 'torque'], [0, 0], [7000, 20]],
    torqueModMult: [['rpm', 'torque'], [0, 1], [7000, 1.5]],
    idleRPM: 800, maxRPM: 7000, revLimiterRPM: 6500, friction: 10, dynamicFriction: 0,
  };
  const c = engineCurves(eng, null, null, null)!;
  expect(c.maxRPM).toBe(6500);
  // below 30 % of idle: no torque (stall cut-off)
  expect(c.combined[200]).toBe(0);
  // at 3500 rpm: table (Catmull-Rom) × mult (linear 1.25) + intake (linear 10)
  const table = c.table[3500];
  expect(c.combined[3500]).toBeCloseTo(table * 1.25 + 10, 3);
  expect(c.na[3500]).toBeCloseTo(c.combined[3500] - 10, 3);
  expect(c.final[3500]).toBeCloseTo(c.na[3500], 6);
  expect(c.final.length).toBe(6500);
  const sc = engineCurves(eng, null, { type: 'roots', gearRatio: 2, pressurePSIPer1kRPM: 1, crankLossPer1kRPM: 0.02, clutchEngageRPM: 0 }, null)!;
  expect(sc.hasSupercharger).toBe(true);
  expect(peak(sc.final)[0]).toBeGreaterThan(peak(c.final)[0]);
});

it('edits layers: a scaled multiplier table reaches a target peak, other configurations only where the value is the same', async () => {
  const { withLayerEdit, solveLayerScale, curvesOf, layerValue } = await import('../src/core/analysis/powertrain');
  const eng = {
    torque: [['rpm', 'torque'], [0, 0], [1000, 200], [4000, 300], [7000, 200]],
    torqueModMult: [['rpm', 'torque'], [0, 1], [7000, 1]],
    idleRPM: 800, maxRPM: 7000, friction: 0, dynamicFriction: 0,
  };
  const d = { eng, turbo: null, sc: null, n2o: null };
  const layer = { id: 'torqueModMult', label: 'Multiplier', section: 'eng' as const, key: 'torqueModMult', yCol: 1, part: 'ecu', file: 'f', unit: '×', xUnit: 'rpm',
    lut: { key: 'torqueModMult', part: 'ecu', file: 'f', arr: null as any, header: ['rpm', 'torque'], rows: [] } };
  const base = peak(curvesOf(d)!.final)[0];
  const s = solveLayerScale(d, layer, base * 1.2)!;
  expect(s).toBeCloseTo(1.2, 3);
  expect(peak(curvesOf(withLayerEdit(d, layer, { kind: 'scale', f: s }))!.final)[0]).toBeCloseTo(base * 1.2, 1);
  // a configuration whose table differs keeps its own
  const other = { ...d, eng: { ...eng, torqueModMult: [['rpm', 'torque'], [0, 1.1], [7000, 1.1]] } };
  expect(withLayerEdit(other, layer, { kind: 'scale', f: 2 }, layerValue(d, layer))).toBe(other);
  // moving a point
  const moved = withLayerEdit(d, layer, { kind: 'point', i: 1, x: 7000, y: 1.5 });
  expect((moved.eng.torqueModMult as any)[2]).toEqual([7000, 1.5]);
  expect(solveLayerScale(d, layer, base * 100)).toBeNull();
});
