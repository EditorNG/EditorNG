import { expect, it } from 'vitest';
import { legacyTriggerRow, legacyLinkRow, legacyEventRow, triggerRow, needsActionsEnabled } from '../src/core/jbeam/generators';
import { TRIGGER_ACTIONS, COMMON_ACTIONS, GENERIC_ACTIONS, LIGHT_ROLES } from '../src/core/jbeam/docs';
import { parseSjson, toJs } from '../src/core/sjson';

const spec = { id: 'sw', idRef: 'a', idX: 'b', idY: 'c', type: 'sphere' as const, size: { x: 0.02, y: 0, z: 0 }, pos: { x: 0.1, y: -0.5, z: 0.8 } };

it('legacy triggers row = triggers2 row with the label after the id', () => {
  const v2 = toJs(parseSjson(triggerRow(spec)).root);
  const v1 = toJs(parseSjson(legacyTriggerRow({ ...spec, label: 'Switch' })).root);
  expect(v1[0]).toBe('sw');
  expect(v1[1]).toBe('Switch');
  expect(v1.slice(2)).toEqual(v2.slice(1));
  expect(toJs(parseSjson(legacyLinkRow('sw', 'ev')).root)).toEqual(['sw', 'action0', 'ev']);
  expect(toJs(parseSjson(legacyEventRow('ev', 'Switch', "electrics.values.x = 1")).root)).toEqual(['ev', 'Switch', 'Switch', { onDown: 'electrics.values.x = 1' }]);
});

it('action catalogue: unique ids, common ones need no actionsEnabled', () => {
  const ids = TRIGGER_ACTIONS.flatMap((g) => g.actions.map((a) => a.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(COMMON_ACTIONS.every((a) => !needsActionsEnabled(a))).toBe(true);
  expect(GENERIC_ACTIONS.every((a) => needsActionsEnabled(a))).toBe(true);
  // the ones vanilla uses most
  for (const a of ['common:toggle_headlights', 'common:activateStarterMotor', 'common:setIgnitionLevel3Momentary', 'common:parkingbrake_toggle', 'common:toggle_foglights', 'door_FR', 'hoodRelease', 'trunk']) expect(ids).toContain(a);
});

it('light roles have unique ids and tokens', () => {
  expect(new Set(LIGHT_ROLES.map((r) => r.id)).size).toBe(LIGHT_ROLES.length);
  expect(new Set(LIGHT_ROLES.map((r) => r.token)).size).toBe(LIGHT_ROLES.length);
});
