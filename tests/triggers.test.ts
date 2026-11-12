import { it, expect } from 'vitest';
import { triggerFrame, quatFromDir, qrot } from '../src/core/jbeam/triggers';

const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-4);

it('quatFromDir maps local Y onto the direction (mathlib convention)', () => {
  const q = quatFromDir([0, 0, -1]);
  expect(close(qrot(q, [0, 1, 0]), [0, 0, -1])).toBe(true);
});

it('flat floor frame: X = +X, Y = down, Z = towards idY (rear)', () => {
  const f = triggerFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0])!;
  console.log(JSON.stringify(f));
  expect(close(f.X, [1, 0, 0])).toBe(true);
  expect(close(f.Y, [0, 0, -1])).toBe(true);
  expect(close(f.Z, [0, 1, 0])).toBe(true);
});
