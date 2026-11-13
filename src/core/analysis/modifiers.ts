/**
 * Row modifiers ({"beamSpring": …} rows) stay in effect for the rest of the section, and the game
 * keeps that state across parts: a modifier not reset at the end of a part "leaks" into the same
 * section of every part assembled after it. Port of the idea of the game's
 * lua/ge/extensions/editor/vehicleEditor/staticEditor/veJBeamModifierLeakVis.lua, including its
 * table of values that count as a reset (its "ignore default values" mode).
 */
import type { ModOrigin, Row, Vehicle } from '../jbeam/types';

const F = Infinity; // FLT_MAX

const BEAMS: Record<string, any[]> = {
  beamPrecompression: [1], beamType: ['|NORMAL', 0, 'NORMAL'], beamLongBound: [1], beamShortBound: [1], beamSpring: [4300000], beamDamp: [580],
  beamDeform: [220000], beamStrength: [F, 'FLT_MAX'], deformLimitExpansion: [F, 'FLT_MAX'], deformLimitStress: [F, 'FLT_MAX'], breakGroupType: [0],
  beamLimitDamp: [1], beamLimitSpring: [1], springExpansion: [4300000], beamLimitDampRebound: [1], beamDampRebound: [580], beamDampFast: [580],
  beamDampReboundFast: [1], beamDampVelocitySplit: [F, 'FLT_MAX'], beamDampVelocitySplitRebound: [F, 'FLT_MAX'], deformLimit: [F, 'FLT_MAX'],
  transitionZone: [0], boundZone: [1], dampCutoffHz: [0], shortBoundRange: [0], longBoundRange: [0], pressurePSI: [30], volumeCoef: [1], surface: [1],
};

/** Values that mean "not set / reset", per section (plus '' and false everywhere). */
export const MODIFIER_DEFAULTS: Record<string, Record<string, any[]>> = {
  nodes: {
    frictionCoef: [1], slidingFrictionCoef: [1], selfCollision: [false], collision: [true], nodeWeight: [25], volumeCoef: [0.1], noLoadCoef: [1],
    fullLoadCoef: [0], stribeckVelMult: [1], stribeckExponent: [1.75], softnessCoef: [0.5], treadCoef: [0.5], loadSensitivitySlope: [0],
    couplerStrength: [F, 'FLT_MAX'], fixed: [false], couplerLock: [false],
  },
  beams: BEAMS,
  hydros: BEAMS,
  triangles: { dragCoef: [100], liftCoef: [100], stallAngle: [0.58], triangleType: ['NORMALTYPE', 0], pressurePSI: [30], groundModel: ['asphalt'], skinDragCoef: [0] },
  props: { min: [0], max: [100], offset: [0], multiplier: [1], lightInnerAngle: [40], lightOuterAngle: [45], lightBrightness: [1], lightRange: [10], flareName: ['vehicleDefaultLightflare'], flareScale: [1], texSize: [256], shadowSoftness: [1] },
  flexbodies: {},
};

/** keys that are bookkeeping, not modifiers */
const IGNORE = new Set(['partOrigin', 'partPath']);

/** sections where values set in one part are meant for others (brake parts feed the wheel rows) */
export const SHARED_BY_DESIGN = new Set(['pressureWheels', 'hubWheels', 'hubWheelsTSV', 'hubWheelsTSI', 'monoHubWheels', 'wheels']);

/** leaking keys that change physics (worth a warning rather than a note) */
export const RISKY_KEYS = new Set([
  'beamSpring', 'beamDamp', 'beamDeform', 'beamStrength', 'beamPrecompression', 'beamType', 'beamLongBound', 'beamShortBound', 'deformLimitExpansion',
  'nodeWeight', 'collision', 'selfCollision', 'frictionCoef', 'nodeMaterial', 'fixed', 'deformGroup', 'breakGroup', 'group', 'triangleType', 'dragCoef', 'liftCoef',
]);

export function isResetValue(section: string, key: string, val: any): boolean {
  if (val === '' || val === false || val === undefined || val === null) return true;
  const d = MODIFIER_DEFAULTS[section]?.[key];
  return !!d && d.includes(val);
}

export interface Leak {
  section: string;
  key: string;
  value: any;
  origin: ModOrigin;
  /** parts the value leaks into, with the affected rows */
  into: Map<string, Row[]>;
}

/** Modifiers set in one part and still in effect (with a non-reset value) for rows of other parts. */
export function modifierLeaks(v: Vehicle): Leak[] {
  const leaks = new Map<string, Leak>();
  for (const [section, rows] of v.tables) {
    if (SHARED_BY_DESIGN.has(section)) continue;
    for (const row of rows) {
      const mods = row.mods;
      if (!mods) continue;
      for (const key in mods) {
        if (IGNORE.has(key)) continue;
        const o = mods[key];
        if (o.part === row.part.def.name) continue;
        const val = row.v[key];
        if (isResetValue(section, key, val)) continue;
        const id = `${o.file}:${o.s}:${key}`;
        let l = leaks.get(id);
        if (!l) leaks.set(id, (l = { section, key, value: val, origin: o, into: new Map() }));
        const p = row.part.def.name;
        (l.into.get(p) ?? l.into.set(p, []).get(p)!).push(row);
      }
    }
  }
  return [...leaks.values()];
}
