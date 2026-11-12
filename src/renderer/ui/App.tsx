import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import {
  Files, Car, Puzzle, Hammer, Bug, Activity as ActivityIcon, Settings as SettingsIcon, Sun, Moon, Save, Undo2, Redo2, Code2, PanelBottom, PanelLeft,
  Command as CommandIcon, Loader2,
} from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, PERSISTED_UI, type Activity } from '../state/ui';
import { useSettings, settings, matches, eventKey } from '../state/settings';
import { ViewportPanel } from '../scene/ViewportPanel';
import { CodeEditor } from '../editor/CodeEditor';
import { VehiclesPanel, ExplorerPanel, PartsPanel } from './SidePanels';
import { BottomPanel } from './BottomPanel';
import { ToolsPanel } from './ToolsPanel';
import { Palette } from './Palette';
import { Toasts } from './Toasts';
import { Dialogs } from './Dialogs';
import { MirrorButton } from './MirrorPart';
import { COMMANDS, command, commandKey } from './commands';
import { api } from '../lib/api';
import { monaco } from '../lib/monaco';

const SettingsPage = lazy(() => import('./SettingsPage'));
const SuspensionPage = lazy(() => import('./SuspensionPage'));

function Splitter(props: { dir: 'x' | 'y'; onDrag: (delta: number) => void; className?: string }) {
  const start = useRef<number | null>(null);
  return (
    <div
      className={'splitter ' + props.dir + ' ' + (props.className ?? '')}
      onPointerDown={(e) => {
        start.current = props.dir === 'x' ? e.clientX : e.clientY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        const p = props.dir === 'x' ? e.clientX : e.clientY;
        props.onDrag(p - start.current);
        start.current = p;
      }}
      onPointerUp={() => (start.current = null)}
    />
  );
}

const MENUS: Array<{ title: string; group: string; extra?: string[] }> = [
  { title: 'File', group: 'File' },
  { title: 'Edit', group: 'Edit' },
  { title: 'View', group: 'View' },
  { title: 'Tools', group: 'Tools' },
  { title: 'Help', group: 'Help' },
];

function TitleBar() {
  const model = useWs((x) => x.model);
  const mode = useWs((x) => x.mode);
  const dirty = useWs((x) => x.dirtyCount);
  const loading = useWs((x) => x.loading);
  const canUndo = useWs((x) => x.canUndo);
  const canRedo = useWs((x) => x.canRedo);
  const theme = useSettings((x) => x.s.theme);
  const editorVisible = useSettings((x) => x.s.editorVisible);
  const bottom = useUi((x) => x.bottom);
  const sidebar = useUi((x) => x.sidebar);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  return (
    <div className="titlebar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 18 L12 4 L20 18 Z" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
          <circle cx="4" cy="18" r="2.4" fill="var(--accent)" />
          <circle cx="12" cy="4" r="2.4" fill="var(--accent)" />
          <circle cx="20" cy="18" r="2.4" fill="var(--accent)" />
        </svg>
        <span className="brand-name">EditorNG</span>
      </div>
      <div className="menus">
        {MENUS.map((m) => (
          <div key={m.title} className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button className={'menu-btn' + (menu === m.title ? ' open' : '')} onClick={() => setMenu(menu === m.title ? null : m.title)} onMouseEnter={() => menu && setMenu(m.title)}>{m.title}</button>
            {menu === m.title && (
              <div className="menu-pop">
                {COMMANDS.filter((c) => c.group === m.group).map((c) => (
                  <button key={c.id} className="ctx-item" disabled={c.enabled ? !c.enabled() : false} onClick={() => { setMenu(null); command(c.id); }}>
                    <span>{c.title}</span>
                    {commandKey(c) && <span className="kbd">{commandKey(c)}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="title-center">
        {loading ? (
          <span className="dim row"><Loader2 size={13} className="spin" /> {loading}</span>
        ) : model ? (
          <span><b>{model}</b>{dirty > 0 && <span className="dim"> · {dirty} unsaved</span>}</span>
        ) : mode === 'loose' ? <span>Loose files{dirty > 0 && <span className="dim"> · {dirty} unsaved</span>}</span> : <span className="dim">No vehicle</span>}
      </div>
      <div className="title-actions">
        <button className="icon-btn" data-tip="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => command('edit.undo')} aria-label="Undo"><Undo2 size={15} /></button>
        <button className="icon-btn" data-tip="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => command('edit.redo')} aria-label="Redo"><Redo2 size={15} /></button>
        <button className={'icon-btn' + (dirty ? ' dirty-save' : '')} data-tip="Save all (Ctrl+Shift+S)" onClick={() => command('app.saveAll')} aria-label="Save all"><Save size={15} /></button>
        <div className="sep-v" />
        <button className={'icon-btn' + (sidebar ? ' active' : '')} data-tip="Sidebar (Ctrl+B)" onClick={() => useUi.setState({ sidebar: !sidebar })} aria-label="Toggle sidebar"><PanelLeft size={15} /></button>
        <button className={'icon-btn' + (bottom ? ' active' : '')} data-tip="Bottom panel (Ctrl+J)" onClick={() => useUi.setState({ bottom: !bottom })} aria-label="Toggle bottom panel"><PanelBottom size={15} /></button>
        <button className={'icon-btn' + (editorVisible ? ' active' : '')} data-tip="Code editor (Ctrl+E)" onClick={() => useSettings.getState().set({ editorVisible: !editorVisible })} aria-label="Toggle code editor"><Code2 size={15} /></button>
        <button className="icon-btn" data-tip="Commands (Ctrl+Shift+P)" onClick={() => useUi.setState({ palette: 'commands' })} aria-label="Command palette"><CommandIcon size={15} /></button>
        <button className="icon-btn" data-tip={theme === 'light' ? 'Dark mode' : 'Light mode'} data-tip-pos="bottom-left" onClick={() => useSettings.getState().set({ theme: theme === 'light' ? 'dark' : 'light' })} aria-label="Toggle theme">
          {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </div>
      <div className="window-controls-space" />
    </div>
  );
}

function ActivityBar() {
  const activity = useUi((x) => x.activity);
  const sidebar = useUi((x) => x.sidebar);
  const page = useUi((x) => x.page);
  const item = (a: Activity, icon: React.ReactNode, tip: string) => (
    <button
      className={'act-btn' + (activity === a && sidebar && page === 'workbench' ? ' active' : '')}
      data-tip={tip}
      data-tip-pos="right"
      aria-label={tip}
      onClick={() => {
        const st = useUi.getState();
        if (st.page !== 'workbench') useUi.setState({ page: 'workbench', activity: a, sidebar: true });
        else if (st.activity === a) useUi.setState({ sidebar: !st.sidebar });
        else useUi.setState({ activity: a, sidebar: true });
      }}
    >
      {icon}
    </button>
  );
  const pageBtn = (p: 'suspension' | 'settings', icon: React.ReactNode, tip: string) => (
    <button className={'act-btn' + (page === p ? ' active' : '')} data-tip={tip} data-tip-pos="right" aria-label={tip} onClick={() => useUi.setState({ page: page === p ? 'workbench' : p })}>
      {icon}
    </button>
  );
  return (
    <div className="activitybar">
      {item('vehicles', <Car size={20} />, 'Vehicles')}
      {item('explorer', <Files size={20} />, 'Files')}
      {item('parts', <Puzzle size={20} />, 'Parts & config')}
      {item('tools', <Hammer size={20} />, 'Create & place')}
      {item('debug', <Bug size={20} />, 'Checks')}
      <div className="grow" />
      {pageBtn('suspension', <ActivityIcon size={20} />, 'Suspension analysis')}
      {pageBtn('settings', <SettingsIcon size={20} />, 'Settings (Ctrl+,)')}
    </div>
  );
}

function SideBar() {
  const activity = useUi((x) => x.activity);
  if (activity === 'vehicles') return <VehiclesPanel />;
  if (activity === 'explorer') return <ExplorerPanel />;
  if (activity === 'parts') return <PartsPanel />;
  if (activity === 'tools') return <ToolsPanel />;
  if (activity === 'debug') {
    return (
      <div className="panel">
        <div className="panel-header"><span className="panel-title">Checks</span></div>
        <div className="panel-pad dim">
          Structural checks run in the bottom panel so results stay visible next to the 3D view.
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => useUi.setState({ bottom: true, bottomTab: 'debug' })}>Open checks</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => useUi.setState({ bottom: true, bottomTab: 'mass' })}>Weight distribution</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => useUi.setState({ page: 'suspension' })}>Suspension analysis</button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function StatusBar() {
  const target = useWs((x) => x.target);
  const v = useWs((x) => x.vehicle);
  const tool = useUi((x) => x.tool);
  const errors = v?.issues.filter((i) => i.sev === 'error').length ?? 0;
  const warnings = v?.issues.filter((i) => i.sev === 'warning').length ?? 0;
  return (
    <div className="statusbar">
      <button className="status-item" onClick={() => useUi.setState({ bottom: true, bottomTab: 'problems' })}>
        <span className={errors ? 'err-text' : ''}>● {errors}</span>
        <span className={warnings ? 'warn-text' : ''}>▲ {warnings}</span>
      </button>
      <span className="status-item">tool: {tool}</span>
      <button className="status-item" onClick={() => useUi.setState({ activity: 'parts', sidebar: true })} title="Where new nodes, beams and triangles are written">
        target: <span className="mono">{target ? target.part : 'auto'}</span>
      </button>
      <div className="grow" />
      {v && <span className="status-item">{v.parts.length} parts</span>}
      <MirrorButton />
      <span className="status-item faint">EditorNG</span>
    </div>
  );
}

export function App() {
  const s = useSettings((x) => x.s);
  const page = useUi((x) => x.page);
  const sidebar = useUi((x) => x.sidebar);
  const bottom = useUi((x) => x.bottom);
  const sideWidth = useUi((x) => x.sideWidth);
  const editorWidth = useUi((x) => x.editorWidth);
  const bottomHeight = useUi((x) => x.bottomHeight);

  // theme
  useEffect(() => {
    const root = document.documentElement;
    const sys = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const theme = s.theme === 'system' ? (sys.matches ? 'light' : 'dark') : s.theme;
      root.dataset.theme = theme;
      root.dataset.density = s.density;
      root.style.setProperty('--accent', s.accent);
      const c = parseInt(s.accent.slice(1), 16);
      root.style.setProperty('--accent-rgb', `${(c >> 16) & 255}, ${(c >> 8) & 255}, ${c & 255}`);
      root.style.setProperty('--ui-scale', String(s.uiScale));
      root.style.setProperty('--speed', s.reduceMotion ? '0ms' : '110ms');
      monaco.editor.setTheme(theme === 'light' ? 'editorng-light' : 'editorng-dark');
      const bg = getComputedStyle(root).getPropertyValue('--bg-1').trim();
      const fg = getComputedStyle(root).getPropertyValue('--text-dim').trim();
      api.setTitleBarColors({ color: bg, symbolColor: fg }).catch(() => {});
    };
    apply();
    sys.addEventListener('change', apply);
    return () => sys.removeEventListener('change', apply);
  }, [s.theme, s.accent, s.uiScale, s.density, s.reduceMotion]);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = eventKey(e);
      if (!k) return;
      const inMonaco = !!(document.activeElement as HTMLElement | null)?.closest('.monaco-editor');
      const inInput = /INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement | null)?.tagName ?? '');
      const global = ['app.save', 'app.saveAll', 'app.palette', 'app.quickOpen', 'app.gotoNode', 'app.settings', 'app.toggleEditor', 'app.toggleBottom', 'app.reload'];
      for (const id of global) {
        if (matches(id, e)) {
          e.preventDefault();
          command(id);
          return;
        }
      }
      if (k === 'Ctrl+B') {
        e.preventDefault();
        command('view.sidebar');
        return;
      }
      if (k === 'F1') {
        e.preventDefault();
        command('help.shortcuts');
        return;
      }
      if (inMonaco || inInput) return;
      if (matches('edit.undo', e)) {
        e.preventDefault();
        command('edit.undo');
      } else if (matches('edit.redo', e) || matches('edit.redoAlt', e)) {
        e.preventDefault();
        command('edit.redo');
      } else if (e.key === 'Escape' && useUi.getState().page !== 'workbench') {
        useUi.setState({ page: 'workbench' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // persist layout
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return useUi.subscribe((st, prev) => {
      if (!PERSISTED_UI.some((k) => st[k] !== prev[k])) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        api.stateLoad().then((cur) => {
          const ui: Record<string, any> = {};
          for (const k of PERSISTED_UI) ui[k] = (useUi.getState() as any)[k];
          api.stateSave({ ...cur, ui, lastVehicle: ws.model, lastConfig: useWs.getState().activeConfig });
        });
      }, 400);
    });
  }, []);
  useEffect(() => useWs.subscribe((st, prev) => {
    if (st.model === prev.model && st.activeConfig === prev.activeConfig) return;
    api.stateLoad().then((cur) => api.stateSave({ ...cur, lastVehicle: st.model, lastConfig: st.activeConfig }));
  }), []);

  const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <ActivityBar />
        {page === 'workbench' && sidebar && (
          <>
            <div className="sidebar" style={{ width: sideWidth }}><SideBar /></div>
            <Splitter dir="x" onDrag={(d) => useUi.setState({ sideWidth: clamp(useUi.getState().sideWidth + d, 180, 560) })} />
          </>
        )}
        <div className="center" style={{ display: page === 'workbench' ? 'flex' : 'none' }}>
          <div className="workbench">
            <div className="work-top">
              <div className="viewport-wrap"><ViewportPanel /></div>
              {s.editorVisible && (
                <>
                  <Splitter dir="x" onDrag={(d) => useUi.setState({ editorWidth: clamp(useUi.getState().editorWidth - d, 280, 1400) })} />
                  <div className="editor-wrap" style={{ width: editorWidth }}><CodeEditor /></div>
                </>
              )}
            </div>
            {bottom && (
              <>
                <Splitter dir="y" onDrag={(d) => useUi.setState({ bottomHeight: clamp(useUi.getState().bottomHeight - d, 90, 700) })} />
                <div className="bottom-wrap" style={{ height: bottomHeight }}><BottomPanel /></div>
              </>
            )}
          </div>
        </div>
        {page !== 'workbench' && (
          <div className="page">
            <Suspense fallback={<div className="empty-hint">Loading…</div>}>
              {page === 'settings' ? <SettingsPage /> : <SuspensionPage />}
            </Suspense>
          </div>
        )}
      </div>
      <StatusBar />
      <Palette />
      <Dialogs />
      <Toasts />
    </div>
  );
}

export { settings };
