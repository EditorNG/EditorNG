// Builds a portable Windows release: release/EditorNG-win32-x64/EditorNG.exe + a zip next to it.
import { packager } from '@electron/packager';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

run('node scripts/build.mjs');

// one folder per version, so a running copy of an older build never blocks packaging
const out = path.join(root, 'release', pkg.version);
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
  extraResource: [path.join(root, 'blender'), path.join(root, 'game'), path.join(root, 'build'), path.join(root, 'licenses')],
  appVersion: pkg.version,
  win32metadata: { CompanyName: 'EditorNG', FileDescription: 'EditorNG — JBeam editor for BeamNG.drive', ProductName: 'EditorNG', OriginalFilename: 'EditorNG.exe' },
  // only the built app goes in: everything is bundled, node_modules are not needed at runtime
  ignore: (p) => (p === '' ? false : !keep.some((re) => re.test(p.replace(/\\/g, '/')))),
  prune: false,
});
// trim what the app never uses: UI translations of Chromium's own dialogs (English only; other system
// languages fall back to it) and the DirectX shader compiler used only by WebGPU (WebGL goes through
// ANGLE's d3dcompiler_47.dll, which stays, as does the software-rendering fallback)
const locales = path.join(appDir, 'locales');
for (const f of fs.readdirSync(locales)) if (f !== 'en-US.pak') fs.rmSync(path.join(locales, f));
for (const f of ['dxcompiler.dll', 'dxil.dll']) fs.rmSync(path.join(appDir, f), { force: true });
// no Python bytecode caches from local Blender runs
fs.rmSync(path.join(appDir, 'resources', 'blender', '__pycache__'), { recursive: true, force: true });
// readme for end users
fs.copyFileSync(path.join(root, 'docs', 'USER_GUIDE.md'), path.join(appDir, 'USER_GUIDE.md'));
const zip = path.join(out, `EditorNG-${pkg.version}-win64.zip`);
run(`powershell -NoProfile -Command "Compress-Archive -Path '${appDir}\\*' -DestinationPath '${zip}' -Force"`);
const size = fs.statSync(zip).size;
console.log(`\nRelease ready:\n  ${appDir}\\EditorNG.exe\n  ${zip} (${(size / 1e6).toFixed(1)} MB)`);
