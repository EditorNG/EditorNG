import { it, expect } from 'vitest';
import { loadJbeamDir } from './helpers';
import { setKnownProps, unknownProps, suggestProp } from '../src/core/jbeam/knownProps';
import snapshot from '../src/core/jbeam/knownProps.snapshot.json';

it('property spellcheck: suggestions and low noise on vanilla', async () => {
  setKnownProps(snapshot as Record<string, string[]>);
  expect(suggestProp('beams', 'beamSprng')).toBe('beamSpring');
  expect(suggestProp('nodes', 'nodeWieght')).toBe('nodeWeight');
  for (const model of ['etk800', 'pickup']) {
    const files = await loadJbeamDir(`vehicles/${model}`);
    const unk = files.flatMap((f) => unknownProps(f));
    const by = new Map<string, number>();
    for (const u of unk) by.set(`${u.section}.${u.key}`, (by.get(`${u.section}.${u.key}`) ?? 0) + 1);
    console.log(model, files.length, 'files,', unk.length, 'flagged:', unk.slice(0, 12).map((x) => `${x.section}.${x.key}→${x.suggestion}`).join(' '));
    expect(unk.length).toBeLessThan(10);
  }
});
