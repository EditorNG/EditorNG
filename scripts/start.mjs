// Starts the built app. Strips ELECTRON_RUN_AS_NODE (set by VS Code terminals), which would make Electron act as plain Node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
