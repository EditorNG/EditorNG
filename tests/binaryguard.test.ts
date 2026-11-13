import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertTextWritable, looksBinary } from '../src/main/binaryGuard';

it('never lets text be written over binary files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-guard-'));
  const png = path.join(dir, 'tex.color.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
  await expect(assertTextWritable(png)).rejects.toThrow(/binary/);
  // binary content under a text-looking name is refused too
  const disguised = path.join(dir, 'oops.jbeam');
  fs.writeFileSync(disguised, Buffer.from([0x44, 0x44, 0x53, 0x20, 1, 2, 3]));
  await expect(assertTextWritable(disguised)).rejects.toThrow(/binary/);
  // text files and new files are fine
  const jb = path.join(dir, 'part.jbeam');
  fs.writeFileSync(jb, '{"a": {}}');
  await expect(assertTextWritable(jb)).resolves.toBeUndefined();
  await expect(assertTextWritable(path.join(dir, 'new.jbeam'))).resolves.toBeUndefined();
  // a new file with a binary extension is refused (text never belongs there)
  await expect(assertTextWritable(path.join(dir, 'new.dds'))).rejects.toThrow(/binary/);
  expect(looksBinary(new TextEncoder().encode('{"text": 1}\r\n'))).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});
