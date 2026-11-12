// Builds main + preload with esbuild and the renderer with Vite.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const only = process.argv[2];

export async function buildMain() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
    logLevel: 'warning',
  };
  await esbuild({ ...common, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(root, 'out/main/main.cjs') });
  await esbuild({ ...common, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(root, 'out/preload/preload.cjs') });
}

if (import.meta.filename === path.resolve(process.argv[1])) {
  const t0 = Date.now();
  if (only !== 'renderer') await buildMain();
  if (only !== 'main') await viteBuild({ configFile: path.join(root, 'vite.config.mts'), logLevel: 'warn' });
  console.log(`build done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
