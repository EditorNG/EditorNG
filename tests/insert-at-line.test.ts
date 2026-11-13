import { it, expect, describe } from 'vitest';
import { parseJbeamFile } from '../src/core/jbeam/parts';
import { applyEdits, insertRowsAtLine } from '../src/core/jbeam/edit';

const SRC = [
  '{',
  '"p": {',
  '    "beams": [',
  '        ["id1:", "id2:"],',
  '        //lengthwise',
  '        ["a1", "a2"],',
  '        ["a2", "a3"],',
  '',
  '        //widthwise',
  '        ["b1", "b2"],',
  '        ["b2", "b3"]',
  '    ],',
  '    "nodes": [',
  '        ["id", "posX", "posY", "posZ"],',
  '    ],',
  '}',
  '}',
].join('\n');

const part = () => parseJbeamFile('t.jbeam', SRC).parts[0];
const at = (needle: string) => SRC.indexOf(needle) + 2;
const ins = (cursor: number, rows = ['["x1", "x2"]']) => {
  const r = insertRowsAtLine(SRC, part(), 'beams', rows, cursor);
  return r ? applyEdits(SRC, r.edits) : null;
};

describe('insertRowsAtLine', () => {
  it('goes right below the row the cursor is on', () => {
    const out = ins(at('["a1", "a2"]'))!;
    expect(out).toContain('["a1", "a2"],\n        ["x1", "x2"],\n        ["a2", "a3"],');
    expect(parseJbeamFile('t.jbeam', out).parts[0].sections.get('beams')).toBeTruthy();
  });
  it('goes below a comment line (start of a group)', () => {
    const out = ins(at('//widthwise'))!;
    expect(out).toContain('//widthwise\n        ["x1", "x2"],\n        ["b1", "b2"],');
  });
  it('adds the missing comma after the last row', () => {
    const out = ins(at('["b2", "b3"]'))!;
    expect(out).toContain('["b2", "b3"],\n        ["x1", "x2"],\n    ],');
  });
  it('the header line inserts at the top', () => {
    const out = ins(at('["id1:", "id2:"]'))!;
    expect(out).toContain('["id1:", "id2:"],\n        ["x1", "x2"],\n        //lengthwise');
  });
  it('is null outside the section (other section or closing bracket line)', () => {
    expect(ins(at('["id", "posX"'))).toBeNull();
    expect(ins(SRC.indexOf('    ],'))).toBeNull();
  });
});
