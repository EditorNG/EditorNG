import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/app.css';
import { monaco } from './lib/monaco';
import { registerJbeam } from './editor/jbeamLang';
import { App } from './ui/App';
import { api } from './lib/api';
import { useSettings, settings } from './state/settings';
import { useUi, PERSISTED_UI, log } from './state/ui';
import { ws, useWs } from './project/workspace';
import { useSel } from './state/selection';
import { toast } from './state/toast';
import * as ops from './project/ops';
import { getViewport } from './scene/ViewportPanel';
import { command } from './ui/commands';
import { meshes, useMeshStatus } from './scene/meshes';

function defineThemes() {
  const accent = 'ff7a1a';
  monaco.editor.defineTheme('editorng-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7584', fontStyle: 'italic' },
      { token: 'keyword.section', foreground: accent, fontStyle: 'bold' },
      { token: 'key', foreground: '9cc3f5' },
      { token: 'string', foreground: 'c9d4a3' },
      { token: 'string.expr', foreground: 'e3a6ff' },
      { token: 'variable', foreground: 'f2c94c' },
      { token: 'type.flag', foreground: '7fd8c4' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'keyword', foreground: 'f28b82' },
      { token: 'identifier', foreground: 'dde1e7' },
    ],
    colors: {
      'editor.background': '#15171a',
      'editor.lineHighlightBackground': '#1d2026',
      'editorLineNumber.foreground': '#4a525e',
      'editorLineNumber.activeForeground': '#aab2bd',
      'editorGutter.background': '#15171a',
      'editor.selectionBackground': '#ff7a1a33',
      'editorCursor.foreground': '#ff7a1a',
      'editorIndentGuide.background1': '#23272e',
      'editorInlayHint.foreground': '#7c8693',
      'editorInlayHint.background': '#00000000',
      'minimap.background': '#15171a',
      'editorStickyScroll.background': '#191c20',
      'editorWidget.background': '#1b1e23',
      'editorSuggestWidget.background': '#1b1e23',
      'editorHoverWidget.background': '#1b1e23',
      'editorHoverWidget.border': '#363d48',
    },
  });
  monaco.editor.defineTheme('editorng-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a93a1', fontStyle: 'italic' },
      { token: 'keyword.section', foreground: 'c2560a', fontStyle: 'bold' },
      { token: 'key', foreground: '1f5fae' },
      { token: 'string', foreground: '4f6b16' },
      { token: 'string.expr', foreground: '8a3fb5' },
      { token: 'variable', foreground: '9a6a00' },
      { token: 'type.flag', foreground: '0f7a68' },
      { token: 'number', foreground: '0b7a4b' },
      { token: 'keyword', foreground: 'c0352b' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.lineHighlightBackground': '#f3f5f8',
      'editor.selectionBackground': '#ff7a1a33',
      'editorCursor.foreground': '#d9620c',
      'editorInlayHint.foreground': '#8a93a1',
      'editorInlayHint.background': '#00000000',
      'editorStickyScroll.background': '#f7f8fa',
    },
  });
}

async function boot() {
  defineThemes();
  registerJbeam();
  await useSettings.getState().load();
  const s = settings();
  const roots = await api.configureRoots({ gameDir: s.gameDir || undefined, userDir: s.userDir || undefined, extraRoots: s.extraRoots });
  if (!s.gameDir && roots.gameDir) useSettings.setState((st) => ({ s: { ...st.s, gameDir: roots.gameDir! } }));
  if (!s.userDir && roots.userDir) useSettings.setState((st) => ({ s: { ...st.s, userDir: roots.userDir! } }));
  const state = await api.stateLoad();
  if (state.ui) {
    const ui: Record<string, any> = {};
    for (const k of PERSISTED_UI) if (k in state.ui) ui[k] = state.ui[k];
    useUi.setState(ui);
  }
  api.blenderLinkPort(s.linkPort).catch(() => {});
  createRoot(document.getElementById('root')!).render(<App />);
  api.onFsChange(async (paths) => {
    const changed = await ws.onExternalChange(paths);
    if (changed.length) {
      log(`Changed on disk: ${changed.join(', ')}`);
      const dirtyOnes = changed.filter((n) => [...ws.docs.values()].some((d) => d.name === n && ws.isDirty(d)));
      if (dirtyOnes.length) toast('warn', `${dirtyOnes.join(', ')} changed on disk but has unsaved edits here`, { label: 'Reload', run: () => ws.reloadFromDisk() });
      else toast('info', `Reloaded ${changed.join(', ')}`, undefined, 1800);
    }
  });
  ws.refreshVehicleList().catch(() => {});
  const env = await api.env();
  log(`EditorNG ${env.appVersion} · game: ${roots.gameDir ?? 'not found'} · user: ${roots.userDir ?? 'not found'}`);
  if (state.lastVehicle && !(window as any).__noRestore) await ws.openVehicle(state.lastVehicle, state.lastConfig ?? undefined);
  // automation hooks (used by scripts/shot.mjs and handy in devtools)
  window.__app = { ready: true, ws, useWs, useUi, useSel, useSettings, ops, command, viewport: getViewport, monaco, meshes, useMeshStatus };
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">EditorNG failed to start:\n${e?.stack ?? e}</pre>`;
});
