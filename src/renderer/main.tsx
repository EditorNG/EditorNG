import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/theme.css';
import './styles/app.css';
import { monaco } from './lib/monaco';
import { registerJbeam } from './editor/jbeamLang';
import { App } from './ui/App';
import { api } from './lib/api';
import { useSettings, settings } from './state/settings';
import { useUi, PERSISTED_UI, log, migrateUi } from './state/ui';
import { ws, useWs } from './project/workspace';
import { useSel } from './state/selection';
import { toast } from './state/toast';
import * as ops from './project/ops';
import { getViewport, getGizmo, getLayers } from './scene/ViewportPanel';
import { command } from './ui/commands';
import { meshes, useMeshStatus } from './scene/meshes';
import { shading } from './scene/shading';
import { revealRange, getEditor } from './editor/CodeEditor';
import { loadRecent, addRecentFiles, restoreSession } from './ui/Tier2';
import { setOnFilesOpened } from './project/workspace';
import { setKnownProps, parseSpellcheckerLua } from '@core/jbeam/knownProps';
import knownSnapshot from '@core/jbeam/knownProps.snapshot.json';

function defineThemes() {
  const accent = 'ff7a2e';
  monaco.editor.defineTheme('editorng-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '667080', fontStyle: 'italic' },
      { token: 'keyword.section', foreground: 'e6e9ee', fontStyle: 'bold' },
      { token: 'key', foreground: '9db4d0' },
      { token: 'string', foreground: 'a9c98a' },
      { token: 'string.expr', foreground: 'c7a6e0' },
      { token: 'variable', foreground: 'd9b46a' },
      { token: 'type.flag', foreground: '7fbfb0' },
      { token: 'number', foreground: accent },
      { token: 'keyword', foreground: 'd48a7a' },
      { token: 'delimiter', foreground: '7c838d' },
      { token: 'delimiter.bracket', foreground: '7c838d' },
      { token: 'identifier', foreground: 'c5cad2' },
    ],
    colors: {
      'editor.background': '#1b1d21',
      'editor.foreground': '#c5cad2',
      'editor.lineHighlightBackground': '#202328',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#555c66',
      'editorLineNumber.activeForeground': '#c5cad2',
      'editorGutter.background': '#1b1d21',
      'editor.selectionBackground': '#ff660030',
      'editor.inactiveSelectionBackground': '#ff66001c',
      'editorCursor.foreground': '#ff6600',
      'editorIndentGuide.background1': '#25282d',
      'editorIndentGuide.activeBackground1': '#30343b',
      'editorBracketMatch.background': '#2f343b',
      'editorBracketMatch.border': '#00000000',
      'editorInlayHint.foreground': '#6d747e',
      'editorInlayHint.background': '#00000000',
      'minimap.background': '#1b1d21',
      'editorStickyScroll.background': '#1d2024',
      'editorWidget.background': '#1d2024',
      'editorWidget.border': '#30343b',
      'editorSuggestWidget.background': '#1d2024',
      'editorSuggestWidget.border': '#30343b',
      'editorSuggestWidget.selectedBackground': '#2f343b',
      'editorHoverWidget.background': '#1d2024',
      'editorHoverWidget.border': '#30343b',
      'scrollbarSlider.background': '#30343b80',
      'scrollbarSlider.hoverBackground': '#444a53a0',
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
      'editor.background': '#f6f7f9',
      'editorGutter.background': '#f6f7f9',
      'minimap.background': '#f6f7f9',
      'editor.lineHighlightBackground': '#eceef1',
      'editor.selectionBackground': '#ff660026',
      'editorCursor.foreground': '#d95300',
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
    const saved = migrateUi(state.ui);
    for (const k of PERSISTED_UI) if (k in saved) ui[k] = saved[k];
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
  // property names for the typo check: the game's own spellchecker list when available
  setKnownProps(knownSnapshot as Record<string, string[]>);
  if (roots.gameDir) {
    api.readTextFile(roots.gameDir + '/lua/ge/extensions/editor/vehicleEditor/staticEditor/veJBeamSpellchecker.lua')
      .then((t) => {
        const lists = parseSpellcheckerLua(t);
        if (lists) setKnownProps(lists);
      })
      .catch(() => {});
  }
  const env = await api.env();
  log(`EditorNG ${env.appVersion} · game: ${roots.gameDir ?? 'not found'} · user: ${roots.userDir ?? 'not found'}`);
  await loadRecent();
  setOnFilesOpened(addRecentFiles);
  if (state.lastVehicle && !(window as any).__noRestore && !env.automation) {
    await ws.openVehicle(state.lastVehicle, state.lastConfig ?? undefined);
    await restoreSession(state.lastVehicle).catch(() => {});
  }
  // automation hooks (used by scripts/shot.mjs and handy in devtools)
  window.__app = { ready: true, ws, useWs, useUi, useSel, useSettings, ops, command, viewport: getViewport, layers: getLayers, gizmo: getGizmo, monaco, meshes, useMeshStatus, revealRange, getEditor, shading };
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">EditorNG failed to start:\n${e?.stack ?? e}</pre>`;
});
