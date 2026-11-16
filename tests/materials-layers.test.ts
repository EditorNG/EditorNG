import { expect, it } from 'vitest';
import { parseMaterialsJson, pbrOf } from '../src/core/materials';

const one = (m: Record<string, any>) => pbrOf(parseMaterialsJson(JSON.stringify({ x: { name: 'x', class: 'Material', version: 1.5, ...m } }), 'm.json')[0]);

it('opacity only counts on translucent or alpha-tested materials (the common brake disc is opaque)', () => {
  const disc = one({ Stages: [{ baseColorMap: 'a.png', opacityFactor: 0 }, {}, {}, {}] });
  expect(disc.transparent).toBe(false);
  expect(disc.baseColor[3]).toBe(1);
  const glass = one({ translucent: true, Stages: [{ baseColorFactor: [1, 1, 1, 0.3] }, {}, {}, {}] });
  expect(glass.transparent).toBe(true);
  expect(glass.baseColor[3]).toBeCloseTo(0.3);
});

it('reads a livery layer: its colour, mask and UV sets', () => {
  const s = one({
    activeLayers: 2,
    Stages: [
      { baseColorMap: '/v/base.png', metallicFactor: 1 },
      { baseColorMap: '/v/livery_b.color.png', diffuseMapUseUV: 1, opacityMap: '/v/livery_c.data.png', opacityMapUseUV: 1, metallicMap: '/v/livery_m.data.png', metallicMapUseUV: 1, metallicFactor: 1, roughnessFactor: 0.5 },
      {}, {},
    ],
  });
  expect(s.layer).toMatchObject({ colorMap: 'v/livery_b.color.png', colorUv: 1, mask: 'v/livery_c.data.png', maskUv: 1, metallicMap: 'v/livery_m.data.png', metallicUv: 1, roughness: 0.5 });
  // a paint layer is not a texture layer
  const paint = one({ activeLayers: 2, Stages: [{ baseColorMap: 'a.png' }, { instanceDiffuse: true, opacityMap: 'm.png' }, {}, {}] });
  expect(paint.layer).toBeUndefined();
  expect(paint.paintMask).toBe('m.png');
});
