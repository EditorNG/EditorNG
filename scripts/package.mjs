// Builds a portable Windows release: release/EditorNG-win32-x64/EditorNG.exe + a zip next to it.
import { packager } from '@electron/packager';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

run('node scripts/make-icon.mjs');
run('node scripts/build.mjs');

const out = path.join(root, 'release');
fs.rmSync(out, { recursive: true, force: true });
const keep = [/^\/package\.json$/, /^\/out(\/|$)/];
const [appDir] = await packager({
  dir: root,
  out,
  name: 'EditorNG',
  executableName: 'EditorNG',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: true,
  icon: path.join(root, 'build', 'icon.ico'),
  extraResource: [path.join(root, 'blender'), path.join(root, 'build')],
  appVersion: pkg.version,
  win32metadata: { CompanyName: 'EditorNG', FileDescription: 'EditorNG — JBeam editor for BeamNG.drive', ProductName: 'EditorNG', OriginalFilename: 'EditorNG.exe' },
  // only the built app goes in: everything is bundled, node_modules are not needed at runtime
  ignore: (p) => (p === '' ? false : !keep.some((re) => re.test(p.replace(/\\/g, '/')))),
  prune: false,
});
// readme for end users
fs.copyFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), path.join(appDir, 'USER_GUIDE.md'));
const zip = path.join(out, `EditorNG-${pkg.version}-win64.zip`);
run(`powershell -NoProfile -Command "Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -Force"`);
const size = fs.statSync(zip).size;
console.log(`\nRelease ready:\n  ${appDir}\\EditorNG.exe\n  ${zip} (${(size / 1e6).toFixed(1)} MB)`);
