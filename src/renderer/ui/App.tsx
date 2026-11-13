import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import {
  ListTree, Hammer, Activity as ActivityIcon, Settings as SettingsIcon, Sun, Moon, Save, Undo2, Redo2, Code2, PanelBottom, PanelLeft,
  Command as CommandIcon, Loader2, ShieldCheck, ChevronUp, FlipHorizontal2, Target,
} from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useUi, PERSISTED_UI, type Activity } from '../state/ui';
import { useSettings, settings, matches, eventKey } from '../state/settings';
import { ViewportPanel } from '../scene/ViewportPanel';
import { CodeEditor } from '../editor/CodeEditor';
import { StructurePanel } from './SidePanels';
import { useSel, resolveSel } from '../state/selection';
import { useChecks, runAllChecks } from '../state/checks';
import { ReloadInGameButton } from './GameLink';
import { MenuHost } from './Menu';
import { useSessionAutosave } from './Tier2';
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
  const activeConfig = useWs((x) => x.activeConfig);
  const configs = useWs((x) => x.configs);
  const config = activeConfig ? (configs.find((c) => c.key === activeConfig)?.name ?? activeConfig).replace(/^.*[\\/]/, '').replace(/\.pc$/i, '') : '';
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
          <span>
            <span className="title-vehicle">{model}</span>
            {config && <span className="faint"> › {config}</span>}
            {dirty > 0 && <span className="dim"> · {dirty} unsaved</span>}
          </span>
        ) : mode === 'loose' ? <span>Loose files{dirty > 0 && <span className="dim"> · {dirty} unsaved</span>}</span> : <span className="dim">No vehicle</span>}
      </div>
      <div className="title-actions">
        <CheckButton />
        <ReloadInGameButton />
        <div className="sep-v" />
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
      {item('structure', <ListTree size={20} />, 'Structure: files, parts, slots')}
      {item('create', <Hammer size={20} />, 'Create & place')}
      <div className="grow" />
      {pageBtn('suspension', <ActivityIcon size={20} />, 'Suspension analysis')}
      {pageBtn('settings', <SettingsIcon size={20} />, 'Settings (Ctrl+,)')}
    </div>
  );
}

function SideBar() {
  const activity = useUi((x) => x.activity);
  return activity === 'create' ? <ToolsPanel /> : <StructurePanel />;
}

/** Runs the structural checks and opens their tab; shows the count of the last run. */
function CheckButton() {
  const v = useWs((x) => x.vehicle);
  const res = useChecks((x) => x.results);
  const forV = useChecks((x) => x.forVehicle);
  const stale = !!res && forV !== v;
  const err = res?.filter((f) => f.sev === 'error').length ?? 0;
  const warn = res?.filter((f) => f.sev === 'warning').length ?? 0;
  return (
    <button className="btn small title-btn" disabled={!v} data-tip={res ? `${err} errors, ${warn} warnings${stale ? ' (vehicle changed since)' : ''}` : 'Run structural checks'} onClick={() => {
      runAllChecks();
      useUi.setState({ bottom: true, bottomTab: 'debug' });
    }}>
      <ShieldCheck size={13} /> Check
      {res && !stale && (err + warn > 0 ? <span className={'badge ' + (err ? 'err' : 'warn')}>{err + warn}</span> : <span className="badge ok">0</span>)}
    </button>
  );
}

/** Status bar target-part picker: the one place that shows and changes where new elements go. */
function TargetPicker() {
  const target = useWs((x) => x.target);
  const v = useWs((x) => x.vehicle);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const writable = (v?.parts ?? []).filter((p) => {
    const d = ws.doc(p.def.file);
    return d?.writable && !d.isCommon;
  });
  return (
    <div className="status-pop-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button className="status-item" onClick={() => setOpen(!open)} data-tip="Target part: where new nodes, beams, triangles… are written" data-tip-pos="top">
        <Target size={12} /> <span className="mono">{target ? target.part : 'auto'}</span> <ChevronUp size={11} />
      </button>
      {open && (
        <div className="menu-pop status-pop">
          <div className="ctx-title">Write new elements into</div>
          <button className={'ctx-item' + (!target ? ' checked' : '')} onClick={() => { ws.clearTarget(); setOpen(false); }}>
            <span>Automatic</span><span className="faint small-text">part you last clicked</span>
          </button>
          {writable.map((p) => (
            <button key={p.def.name} className={'ctx-item' + (target?.part === p.def.name ? ' checked' : '')} onClick={() => { ws.setTarget(p.def.file, p.def.name); setOpen(false); }}>
              <span className="mono">{p.def.name}</span>
            </button>
          ))}
          {!writable.length && <div className="ctx-item" style={{ opacity: 0.6 }}>No editable part. Right-click a file → Make editable copy.</div>}
        </div>
      )}
    </div>
  );
}

function SelectionSummary() {
  const v = useWs((x) => x.vehicle);
  const sel = useSel((x) => x.sel);
  if (!v) return null;
  const si = resolveSel(v, sel);
  const bits: string[] = [];
  const add = (n: number, w: string) => n && bits.push(`${n} ${w}${n > 1 ? 's' : ''}`);
  add(si.nodes.size, 'node');
  add(si.beams.size, 'beam');
  add(si.tris.size, 'tri');
  add(si.triggers.size, 'trigger');
  add(si.flex.size + si.props.size, 'mesh');
  if (!bits.length) return null;
  if (si.nodes.size === 1 && bits.length === 1) return <span className="status-item mono">{v.nodes[[...si.nodes][0]].name}</span>;
  return <span className="status-item">{bits.join(' · ')}</span>;
}

function StatusBar() {
  const v = useWs((x) => x.vehicle);
  const sym = useSettings((x) => x.s.symmetryX);
  const errors = v?.issues.filter((i) => i.sev === 'error').length ?? 0;
  const warnings = v?.issues.filter((i) => i.sev === 'warning').length ?? 0;
  return (
    <div className="statusbar">
      <button className="status-item" onClick={() => useUi.setState({ bottom: true, bottomTab: 'problems' })} data-tip="Problems" data-tip-pos="top">
        <span className={errors ? 'err-text' : ''}>● {errors}</span>
        <span className={warnings ? 'warn-text' : ''}>▲ {warnings}</span>
      </button>
      {v && <TargetPicker />}
      <SelectionSummary />
      <div className="grow" />
      <MirrorButton />
      {v && (
        <button className={'status-item' + (sym ? ' on' : '')} onClick={() => useSettings.getState().set({ symmetryX: !sym })} data-tip="X symmetry (Shift+X)" data-tip-pos="top">
          <FlipHorizontal2 size={12} /> {sym ? 'Symmetry on' : 'Symmetry off'}
        </button>
      )}
      {v && <span className="status-item faint">{v.parts.length} parts</span>}
    </div>
  );
}

export function App() {
  useSessionAutosave();
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
      const bg = getComputedStyle(root).getPropertyValue('--bg-3').trim();
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
      const global = ['app.save', 'app.saveAll', 'app.palette', 'app.quickOpen', 'app.gotoNode', 'app.settings', 'app.toggleEditor', 'app.toggleBottom', 'app.reload', 'game.reload'];
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
                  <div className="editor-wrap" style={{ width: editorWidth, maxWidth: `calc(100vw - ${page === 'workbench' && sidebar ? sideWidth : 0}px - 48px - 480px)` }}><CodeEditor /></div>
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
      <MenuHost />
    </div>
  );
}

export { settings };
