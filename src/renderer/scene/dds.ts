/**
 * DDS reader for the formats BeamNG ships: BC1/BC2/BC3 (DXT1/3/5), BC4 (ATI1), BC5 (ATI2),
 * BC7 (DXGI 98/99) and plain 32-bit BGRA. three's DDSLoader stops at DXT5/BC6H; the GPU decodes
 * BC4/BC5/BC7 through WebGL extensions, which this checks before handing data over.
 */
import * as THREE from 'three';

const FOURCC = (s: string) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

interface Fmt {
  format: THREE.CompressedPixelFormat;
  block: number;
  ext: string;
  srgb?: boolean;
}

function formatOf(four: number, dxgi: number): Fmt | null {
  const S3TC = 'WEBGL_compressed_texture_s3tc';
  const RGTC = 'EXT_texture_compression_rgtc';
  const BPTC = 'EXT_texture_compression_bptc';
  if (four === FOURCC('DXT1')) return { format: THREE.RGBA_S3TC_DXT1_Format, block: 8, ext: S3TC };
  if (four === FOURCC('DXT3')) return { format: THREE.RGBA_S3TC_DXT3_Format, block: 16, ext: S3TC };
  if (four === FOURCC('DXT5')) return { format: THREE.RGBA_S3TC_DXT5_Format, block: 16, ext: S3TC };
  if (four === FOURCC('ATI1') || four === FOURCC('BC4U')) return { format: THREE.RED_RGTC1_Format, block: 8, ext: RGTC };
  if (four === FOURCC('BC4S')) return { format: THREE.SIGNED_RED_RGTC1_Format, block: 8, ext: RGTC };
  if (four === FOURCC('ATI2') || four === FOURCC('BC5U')) return { format: THREE.RED_GREEN_RGTC2_Format, block: 16, ext: RGTC };
  if (four === FOURCC('BC5S')) return { format: THREE.SIGNED_RED_GREEN_RGTC2_Format, block: 16, ext: RGTC };
  if (four === FOURCC('DX10')) {
    switch (dxgi) {
      case 71:
      case 72:
        return { format: THREE.RGBA_S3TC_DXT1_Format, block: 8, ext: S3TC, srgb: dxgi === 72 };
      case 74:
      case 75:
        return { format: THREE.RGBA_S3TC_DXT3_Format, block: 16, ext: S3TC, srgb: dxgi === 75 };
      case 77:
      case 78:
        return { format: THREE.RGBA_S3TC_DXT5_Format, block: 16, ext: S3TC, srgb: dxgi === 78 };
      case 80:
        return { format: THREE.RED_RGTC1_Format, block: 8, ext: RGTC };
      case 81:
        return { format: THREE.SIGNED_RED_RGTC1_Format, block: 8, ext: RGTC };
      case 83:
        return { format: THREE.RED_GREEN_RGTC2_Format, block: 16, ext: RGTC };
      case 84:
        return { format: THREE.SIGNED_RED_GREEN_RGTC2_Format, block: 16, ext: RGTC };
      case 98:
      case 99:
        return { format: THREE.RGBA_BPTC_Format, block: 16, ext: BPTC, srgb: dxgi === 99 };
    }
  }
  return null;
}

/** null when the format is unsupported (by this reader or by the GPU). */
export function parseDds(buf: ArrayBuffer, renderer: THREE.WebGLRenderer, srgb: boolean): THREE.Texture | null {
  const h = new Int32Array(buf, 0, 32);
  if (h[0] !== FOURCC('DDS ')) return null;
  const height = h[3], width = h[4];
  const mipCount = Math.max(1, h[7]);
  const pfFlags = h[20];
  const four = h[21];
  let offset = 128;
  let dxgi = 0;
  if (four === FOURCC('DX10')) {
    dxgi = new Int32Array(buf, 128, 5)[0];
    offset = 148;
  }
  // uncompressed 32-bit (BGRA or RGBA by masks)
  if (!(pfFlags & 0x4) && h[22] === 32) {
    const rMask = h[23] >>> 0;
    const src = new Uint8Array(buf, offset, width * height * 4);
    const dst = new Uint8Array(width * height * 4);
    const bgra = rMask === 0x00ff0000;
    for (let i = 0; i < src.length; i += 4) {
      dst[i] = bgra ? src[i + 2] : src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = bgra ? src[i] : src[i + 2];
      dst[i + 3] = src[i + 3];
    }
    const t = new THREE.DataTexture(dst, width, height, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  }
  const fmt = formatOf(four, dxgi);
  if (!fmt || !renderer.extensions.has(fmt.ext)) return null;
  const mipmaps: Array<{ data: Uint8Array; width: number; height: number }> = [];
  let w = width, hgt = height;
  for (let i = 0; i < mipCount; i++) {
    const size = Math.max(4, w) / 4 * (Math.max(4, hgt) / 4) * fmt.block;
    if (offset + size > buf.byteLength) break;
    mipmaps.push({ data: new Uint8Array(buf, offset, size), width: w, height: hgt });
    offset += size;
    w = Math.max(1, w >> 1);
    hgt = Math.max(1, hgt >> 1);
  }
  if (!mipmaps.length) return null;
  const t = new THREE.CompressedTexture(mipmaps as any, width, height, fmt.format);
  t.colorSpace = srgb || fmt.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.needsUpdate = true;
  return t;
}
