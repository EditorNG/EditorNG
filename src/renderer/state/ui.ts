import { create } from 'zustand';

export type Activity = 'explorer' | 'vehicles' | 'parts' | 'tools' | 'debug' | 'search';
export type Page = 'workbench' | 'suspension' | 'settings';
export type Tool = 'select' | 'addNode' | 'beam' | 'tri' | 'name';
export type BottomTab = 'problems' | 'debug' | 'mass' | 'variables' | 'output';

export interface UiState {
  activity: Activity;
  sidebar: boolean;
  page: Page;
  tool: Tool;
  bottom: boolean;
  bottomTab: BottomTab;
  tabs: string[];
  activeTab: string | null;
  palette: null | 'commands' | 'files' | 'nodes' | 'vehicles';
  dialog: null | { kind: string; data?: any };
  sideWidth: number;
  editorWidth: number;
  bottomHeight: number;
  /** sequential naming tool state */
  naming: { prefix: string; next: number; mirror: boolean };
  output: string[];
  /** a form is waiting for a node to be clicked in 3D */
  pick: null | { label: string; cb: (node: string) => void };
  /** "Add" menu → open a placer pre-filled with a position / nodes */
  toolReq: null | { section: string; pos?: [number, number, number]; nodes?: string[]; seq: number };
}

export const useUi = create<UiState>(() => ({
  activity: 'explorer',
  sidebar: true,
  page: 'workbench',
  tool: 'select',
  bottom: true,
  bottomTab: 'problems',
  tabs: [],
  activeTab: null,
  palette: null,
  dialog: null,
  sideWidth: 270,
  editorWidth: 560,
  bottomHeight: 210,
  naming: { prefix: 'n', next: 1, mirror: true },
  output: [],
  pick: null,
  toolReq: null,
}));

let reqSeq = 1;
export function requestTool(section: string, pos?: [number, number, number], nodes?: string[]) {
  useUi.setState({ toolReq: { section, pos, nodes, seq: reqSeq++ }, activity: 'tools', sidebar: true, page: 'workbench' });
}

export function requestPick(label: string): Promise<string | null> {
  return new Promise((resolve) => {
    const prev = useUi.getState().pick;
    if (prev) prev.cb('');
    useUi.setState({ pick: { label, cb: (n) => { useUi.setState({ pick: null }); resolve(n || null); } } });
  });
}

export function openTab(key: string) {
  const k = key.toLowerCase();
  const s = useUi.getState();
  const tabs = s.tabs.includes(k) ? s.tabs : [...s.tabs, k];
  useUi.setState({ tabs, activeTab: k });
}

export function closeTab(key: string) {
  const s = useUi.getState();
  const i = s.tabs.indexOf(key);
  if (i < 0) return;
  const tabs = s.tabs.filter((t) => t !== key);
  const active = s.activeTab === key ? tabs[Math.min(i, tabs.length - 1)] ?? null : s.activeTab;
  useUi.setState({ tabs, activeTab: active });
}

export function log(line: string) {
  const t = new Date().toLocaleTimeString();
  useUi.setState((s) => ({ output: [...s.output.slice(-400), `[${t}] ${line}`] }));
}

/** Layout values persisted across sessions. */
export const PERSISTED_UI: Array<keyof UiState> = ['activity', 'sidebar', 'bottom', 'bottomTab', 'sideWidth', 'editorWidth', 'bottomHeight', 'naming'];
