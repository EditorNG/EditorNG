/**
 * Last line of defence for text saves: never write text over a binary file.
 * (A binary file read as text and written back as UTF-8 is destroyed: 0x89 'PNG' becomes EF BF BD…)
 */
import * as fsp from 'node:fs/promises';

/** Extensions that are never text, whatever their content. */
export const BINARY_EXT = /\.(png|jpe?g|dds|tga|bmp|gif|webp|tiff?|exr|hdr|psd|xcf|kra|blend\d*|fbx|obj\.bin|zip|7z|rar|ogg|wav|mp3|flac|ttf|otf|woff2?|bin|exe|dll|pdf|ter|bmpx|cdae|dae\.cache)$/i;

const MAGIC: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x44, 0x44, 0x53, 0x20], // DDS
  [0xff, 0xd8, 0xff], // JPEG
  [0x50, 0x4b, 0x03, 0x04], // zip
  [0x76, 0x2f, 0x31, 0x01], // OpenEXR
  [0x4f, 0x67, 0x67, 0x53], // Ogg
  [0x52, 0x49, 0x46, 0x46], // RIFF (wav, webp)
  [0x42, 0x4c, 0x45, 0x4e], // BLENDER
  [0x47, 0x49, 0x46, 0x38], // GIF
];

/** True when bytes look like a binary file: a known signature, or a NUL byte early on. */
export function looksBinary(buf: Uint8Array): boolean {
  for (const m of MAGIC) if (buf.length >= m.length && m.every((b, i) => buf[i] === b)) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Throws when writing text to this path would clobber a binary file. */
export async function assertTextWritable(real: string): Promise<void> {
  if (BINARY_EXT.test(real)) throw new Error(`Refusing to write text into a binary file (${real.split(/[\\/]/).pop()})`);
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(real, 'r');
    const buf = new Uint8Array(8000);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (looksBinary(buf.subarray(0, bytesRead))) throw new Error(`Refusing to write text over binary content (${real.split(/[\\/]/).pop()})`);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return; // new file
    throw e;
  } finally {
    await fh?.close();
  }
}
