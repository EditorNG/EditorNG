import { it, expect } from 'vitest';
import yauzl from 'yauzl';
import { makeZip } from '../src/main/zip';

function readAll(buf: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Record<string, string> = {};
      zip.readEntry();
      zip.on('entry', (e) => {
        zip.openReadStream(e, (err2, s) => {
          if (err2 || !s) return reject(err2);
          const chunks: Buffer[] = [];
          s.on('data', (c) => chunks.push(c));
          s.on('end', () => {
            out[e.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
    });
  });
}

it('zip round-trip (stored and deflated entries, utf-8 names)', async () => {
  const big = '{"nodes": [' + '["n", 0, 0, 0],'.repeat(500) + ']}';
  const zip = makeZip([
    { name: 'vehicles/box/box.jbeam', data: Buffer.from(big) },
    { name: 'vehicles/box/info.json', data: Buffer.from('{}') },
    { name: 'vehicles/box/ünï.txt', data: Buffer.from('x') },
  ]);
  const files = await readAll(zip);
  expect(Object.keys(files).sort()).toEqual(['vehicles/box/box.jbeam', 'vehicles/box/info.json', 'vehicles/box/ünï.txt']);
  expect(files['vehicles/box/box.jbeam']).toBe(big);
  expect(zip.length).toBeLessThan(big.length);
});
