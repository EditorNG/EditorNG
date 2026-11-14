import { expect, it } from 'vitest';
import { compareVersions, parseVersion, newerReleases, parseChangelog, combinedChangelog } from '../src/core/update';

it('versions', () => {
  expect(parseVersion('v0.2.13')).toEqual([0, 2, 13]);
  expect(parseVersion('0.2.13-beta')).toBeNull();
  expect(compareVersions('0.2.13', 'v0.2.12')).toBeGreaterThan(0);
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
});

const rel = (tag: string, extra: Record<string, any> = {}) => ({
  tag_name: tag, name: `EditorNG ${tag.slice(1)}`, draft: false, prerelease: false, published_at: '2026-11-20T10:00:00Z', body: '', html_url: 'https://example/' + tag,
  assets: [{ name: `EditorNG-${tag.slice(1)}-win64.zip`, size: 1000, browser_download_url: 'https://example/' + tag + '.zip', digest: 'sha256:ab', state: 'uploaded' }],
  ...extra,
});

it('offers only newer published releases, newest first', () => {
  const list = [rel('v0.2.12'), rel('v0.2.14'), rel('v0.2.13'), rel('v0.3.0', { prerelease: true }), rel('v0.2.15', { draft: true }), rel('nightly')];
  const r = newerReleases(list, '0.2.12');
  expect(r.map((x) => x.version)).toEqual(['0.2.14', '0.2.13']);
  expect(r[0].asset).toEqual({ name: 'EditorNG-0.2.14-win64.zip', size: 1000, url: 'https://example/v0.2.14.zip', digest: 'sha256:ab' });
  expect(newerReleases(list, '0.2.14')).toEqual([]);
  expect(newerReleases({ message: 'API rate limit exceeded' }, '0.2.12')).toEqual([]);
  expect(newerReleases([rel('v0.2.13', { assets: [] })], '0.2.12')[0].asset).toBeUndefined();
});

it('changelog: features, improvements and fixes; install sections skipped', () => {
  const body = [
    'Intro line.',
    '## Download and run',
    '1. Download the zip',
    '- not a change',
    '## New',
    '### Auto update',
    'EditorNG updates itself.',
    'Second line.',
    '- **Changelog preview**: see what is new before installing.',
    '## Improvements',
    '- Faster loading',
    '  of big vehicles.',
    '## Fixes',
    '- Highlighting of `$=` strings.',
  ].join('\n');
  const c = parseChangelog(body, '0.2.13');
  expect(c.features).toEqual([
    { title: 'Auto update', text: 'EditorNG updates itself. Second line.', version: '0.2.13' },
    { title: 'Changelog preview', text: 'see what is new before installing.', version: '0.2.13' },
  ]);
  expect(c.improvements).toEqual([{ text: 'Faster loading of big vehicles.', version: '0.2.13' }]);
  expect(c.fixes).toEqual([{ text: 'Highlighting of `$=` strings.', version: '0.2.13' }]);
});

it('changelog: older single-list notes (0.2.12 style)', () => {
  const body = "## What's in 0.2.12\n\n- **Search bar** in the title bar.\n- Tooltips on every setting.\n";
  const c = parseChangelog(body, '0.2.12');
  expect(c.features.map((f) => f.title)).toEqual(['Search bar']);
  expect(c.improvements.map((f) => f.text)).toEqual(['Tooltips on every setting.']);
});

it('combines several releases, newest first', () => {
  const r = newerReleases([rel('v0.2.13', { body: '## New\n- **A**: a' }), rel('v0.2.14', { body: '## New\n- **B**: b\n## Fixes\n- f' })], '0.2.12');
  const c = combinedChangelog(r);
  expect(c.features.map((f) => f.title + f.version)).toEqual(['B0.2.14', 'A0.2.13']);
  expect(c.fixes.length).toBe(1);
});
