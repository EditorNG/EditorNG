import { expect, it } from 'vitest';
import { merge3, mergedText, splitLines } from '../src/core/merge';

const L = (...xs: string[]) => xs.map((x) => x + '\n').join('');


it('splits lines keeping endings', () => {
    expect(splitLines('a\nb\r\nc')).toEqual(['a\n', 'b\r\n', 'c']);
    expect(splitLines('')).toEqual([]);
  });

it('takes changes made on one side only', () => {
    const base = L('a', 'b', 'c', 'd', 'e');
    const ours = L('a', 'B', 'c', 'd', 'e');
    const theirs = L('a', 'b', 'c', 'd', 'E');
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(0);
    expect(mergedText(r)).toBe(L('a', 'B', 'c', 'd', 'E'));
  });

it('merges insertions and deletions on both sides', () => {
    const base = L('["n1", 0, 0, 0],', '["n2", 1, 0, 0],', '["n3", 2, 0, 0],', '["n4", 3, 0, 0],');
    const ours = L('["n1", 0, 0, 0],', '["n2", 1, 0, 0],', '["n3", 2, 0, 0],', '["n3b", 2.5, 0, 0],', '["n4", 3, 0, 0],');
    const theirs = L('["n1", 0, 0, 0],', '["n3", 2, 0, 0],', '["n4", 3, 0, 0],', '["n5", 4, 0, 0],');
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(0);
    expect(mergedText(r)).toBe(L('["n1", 0, 0, 0],', '["n3", 2, 0, 0],', '["n3b", 2.5, 0, 0],', '["n4", 3, 0, 0],', '["n5", 4, 0, 0],'));
  });

it('an insertion right next to a line the other side deleted is a conflict (like git)', () => {
    const r = merge3(L('a', 'b', 'c'), L('a', 'b', 'b2', 'c'), L('a', 'c'));
    expect(r.conflicts).toBe(1);
  });

it('takes identical changes once', () => {
    const base = L('a', 'b', 'c');
    const both = L('a', 'X', 'c');
    const r = merge3(base, both, both);
    expect(r.conflicts).toBe(0);
    expect(mergedText(r)).toBe(both);
  });

it('reports a conflict when both sides change the same line differently', () => {
    const base = L('a', 'b', 'c');
    const r = merge3(base, L('a', 'mine', 'c'), L('a', 'theirs', 'c'));
    expect(r.conflicts).toBe(1);
    expect(mergedText(r, () => 'ours')).toBe(L('a', 'mine', 'c'));
    expect(mergedText(r, () => 'theirs')).toBe(L('a', 'theirs', 'c'));
    expect(mergedText(r, () => 'both')).toBe(L('a', 'mine', 'theirs', 'c'));
  });

it('in-place edits of neighbouring lines only conflict where both sides changed the same line', () => {
  const base = L('["a1", 0, 0, 0],', '["a2", 1, 0, 0],', '["a3", 2, 0, 0],');
  const ours = L('["a1", 0, 0, 1],', '["a2", 1, 0.5, 0],', '["a3", 2, 0, 0],');
  const theirs = L('["a1", 0, 0, 2],', '["a2", 1, 0, 0],', '["a3", 2, 0, 7],');
  const r = merge3(base, ours, theirs);
  expect(r.conflicts).toBe(1);
  expect(mergedText(r, () => 'theirs')).toBe(L('["a1", 0, 0, 2],', '["a2", 1, 0.5, 0],', '["a3", 2, 0, 7],'));
});

it('handles a last line without newline and CRLF vs LF', () => {
    const base = 'a\r\nb\r\nc';
    const ours = 'a\r\nB\r\nc';
    const theirs = 'a\nb\nc\nd';
    const r = merge3(base, ours, theirs);
    expect(r.conflicts).toBe(0);
    expect(mergedText(r).replace(/\r/g, '')).toBe('a\nB\nc\nd');
  });

it('is fast on a large file with a few edits', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `["n${i}", ${i}, 0, 0],`);
    const base = L(...lines);
    const o = [...lines];
    o[100] = '["changed", 0, 0, 0],';
    const t = [...lines];
    t.splice(15000, 1);
    t.push('["new", 1, 2, 3],');
    const t0 = performance.now();
    const r = merge3(base, L(...o), L(...t));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.conflicts).toBe(0);
    const out = splitLines(mergedText(r));
    expect(out.length).toBe(20000);
    expect(out[100]).toBe('["changed", 0, 0, 0],\n');
    expect(out[out.length - 1]).toBe('["new", 1, 2, 3],\n');
  });

it('randomised: one-sided edits always merge to that side', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 200; t++) {
      const base = Array.from({ length: 30 }, (_, i) => 'l' + (i % 7));
      const ours = [...base];
      for (let e = 0; e < 4; e++) {
        const at = Math.floor(rnd() * ours.length);
        const op = rnd();
        if (op < 0.33) ours.splice(at, 1);
        else if (op < 0.66) ours.splice(at, 0, 'x' + e);
        else ours[at] = 'y' + e;
      }
      const r = merge3(L(...base), L(...ours), L(...base));
      expect(r.conflicts).toBe(0);
      expect(mergedText(r)).toBe(L(...ours));
      const r2 = merge3(L(...base), L(...base), L(...ours));
      expect(mergedText(r2)).toBe(L(...ours));
    }
  });

