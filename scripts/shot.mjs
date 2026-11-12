// Launches the built app with Playwright, optionally runs a script in the renderer, and saves a screenshot.
//   node scripts/shot.mjs <name> [--js "<async function body>"] [--file script.js] [--wait ms] [--size WxH] [--keep-profile]
// Inside the script, `app` is window.__app (the automation hooks exposed by the renderer).
import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const name = args[0] ?? 'shot';
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const js = opt('--js');
const jsFile = opt('--file');
const wait = Number(opt('--wait', '1200'));
const [w, h] = opt('--size', '1600x960').split('x').map(Number);
const keep = args.includes('--keep-profile');
const profile = keep ? path.join(root, '.cache', 'profile') : fs.mkdtempSync(path.join(os.tmpdir(), 'editorng-shot-'));

fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, EDITORNG_USERDATA: profile, EDITORNG_NO_MAXIMIZE: '1' },
});
const page = await app.firstWindow();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await app.evaluate(({ BrowserWindow }, size) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(size.w, size.h);
}, { w, h });
await page
  .waitForFunction(() => window.__app?.ready === true, null, { timeout: 30000 })
  .catch(() => logs.push('[shot] app never became ready'));
let result;
const code = jsFile ? fs.readFileSync(jsFile, 'utf8') : js;
if (code) {
  try {
    result = await page.evaluate(async (src) => {
      const fn = new Function('app', `return (async () => { ${src} })()`);
      return await fn(window.__app);
    }, code);
  } catch (e) {
    logs.push('[shot] script error: ' + e.message);
  }
}
await page.waitForTimeout(wait);
const file = path.join(root, 'shots', name + '.png');
await page.screenshot({ path: file });
if (result !== undefined) console.log('RESULT', typeof result === 'string' ? result : JSON.stringify(result, null, 1));
const shown = logs.filter((l) => !/Download the React DevTools|\[vite\]|Electron Security Warning/.test(l));
if (shown.length) console.log(shown.slice(0, 60).join('\n'));
console.log('saved', file);
await app.close().catch(() => {});
if (!keep) fs.rmSync(profile, { recursive: true, force: true });
