// Dev mode: Vite dev server + Electron pointing at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildMain } from './build.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
await buildMain();
const server = await createServer({ configFile: path.join(root, 'vite.config.mts') });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = require('electron');
const env = { ...process.env, EDITORNG_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env });
child.on('exit', async () => {
  await server.close();
  process.exit(0);
});
