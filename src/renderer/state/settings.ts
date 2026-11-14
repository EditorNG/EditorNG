import { create } from 'zustand';
import { api } from '../lib/api';

export type BeamColorMode = 'type' | 'part' | 'stiffness' | 'uniform' | 'deformGroup';

export const DEFAULT_KEYMAP: Record<string, string> = {
  'select.all': 'A',
  'select.none': 'Alt+A',
  'select.invert': 'Ctrl+I',
  'select.linked': 'L',
  'select.mirror': 'Shift+M',
  'transform.grab': 'G',
  'transform.scale': 'S',
  'transform.rotate': 'R',
  'add.menu': 'Shift+A',
  'tool.select': 'Q',
  'tool.addNode': 'N',
  'tool.beam': 'B',
  'tool.tri': 'T',
  'tool.name': 'Shift+N',
  'edit.extrude': 'E',
  'edit.connect': 'F',
  'edit.flipTri': 'Ctrl+F',
  'edit.delete': 'X',
  'edit.deleteAlt': 'Delete',
  'edit.rename': 'F2',
  'edit.mirror': 'Ctrl+M',
  'edit.duplicate': 'Shift+D',
  'edit.symmetry': 'Shift+X',
  'edit.snapRail': 'Shift+R',
  'edit.undo': 'Ctrl+Z',
  'edit.redo': 'Ctrl+Y',
  'edit.redoAlt': 'Ctrl+Shift+Z',
  'view.frame': 'F',
  'view.frameSelected': 'Numpad.',
  'view.frameAll': 'Home',
  'view.front': 'Numpad1',
  'view.back': 'Ctrl+Numpad1',
  'view.side': 'Numpad3',
  'view.sideOther': 'Ctrl+Numpad3',
  'view.top': 'Numpad7',
  'view.bottom': 'Ctrl+Numpad7',
  'view.ortho': 'Numpad5',
  'view.toggleLabels': 'Shift+L',
  'view.toggleMeshes': '',
  'view.hide': 'H',
  'view.hideOthers': 'Shift+H',
  'view.unhide': 'Alt+H',
  'select.grow': 'Ctrl+Numpad+',
  'select.shrink': 'Ctrl+Numpad-',
  'edit.merge': 'M',
  'view.isolatePart': 'Shift+I',
  'view.xray': 'Alt+Z',
  'view.shading': 'Z',
  'mode.nodes': '1',
  'mode.beams': '2',
  'mode.tris': '3',
  'app.save': 'Ctrl+S',
  'app.saveAll': 'Ctrl+Shift+S',
  'app.palette': 'Ctrl+Shift+P',
  'app.quickOpen': 'Ctrl+P',
  'app.gotoNode': 'Ctrl+G',
  'app.settings': 'Ctrl+,',
  'app.toggleEditor': 'Ctrl+E',
  'app.toggleBottom': 'Ctrl+J',
  'app.reload': 'Ctrl+R',
  'game.reload': 'F5',
};

export interface Settings {
  // appearance
  theme: 'dark' | 'light' | 'system';
  accent: string;
  uiScale: number;
  density: 'compact' | 'comfortable';
  reduceMotion: boolean;

  // viewport
  nodeSize: number;
  nodeWorldScale: boolean;
  beamWidth: number;
  triOpacity: number;
  meshOpacity: number;
  showMeshes: boolean;
  meshWireframe: boolean;
  /** flexbody / prop look: transparent + wire overlay, plain grey-white, or game materials (PBR) */
  meshShading: 'wireframe' | 'solid' | 'shaded';
  /** equirectangular .hdr for the Shaded view (empty: built-in studio) */
  shadedEnvHdr: string;
  /** brightness of the Shaded environment (studio or HDRI, which is normalised first) */
  shadedEnvBrightness: number;
  meshColorByPart: boolean;
  showNodes: boolean;
  showBeams: boolean;
  showTris: boolean;
  showTriNormals: boolean;
  showWheels: boolean;
  showProps: boolean;
  showOccupants: boolean;
  showRails: boolean;
  paletteVersion: number;
  symmetryX: boolean;
  gizmo: 'none' | 'translate' | 'rotate' | 'scale';
  showTriggers: boolean;
  /** what a plain click / box select can pick (Alt+click always reaches meshes, props and triggers) */
  selNodes: boolean;
  selBeams: boolean;
  selTris: boolean;
  selTriggers: boolean;
  selFlex: boolean;
  selProps: boolean;
  showGrid: boolean;
  showAxes: boolean;
  showGround: boolean;
  showLabels: 'off' | 'selected' | 'hover' | 'all';
  labelSize: number;
  beamColorMode: BeamColorMode;
  colorNode: string;
  colorNodeFixed: string;
  colorBeam: string;
  colorBeamAniso: string;
  colorBeamBounded: string;
  colorBeamSupport: string;
  colorBeamHydro: string;
  colorBeamPressured: string;
  colorBeamLbeam: string;
  colorTri: string;
  /** back faces of collision triangles (the game shows them purple) */
  colorTriBack: string;
  colorSelect: string;
  colorHighlight: string;
  dimOtherParts: boolean;
  dimOpacity: number;
  xray: boolean;
  fov: number;
  antialias: boolean;
  pixelRatioCap: number;
  orbitButton: 'middle' | 'right';
  frameOnScope: boolean;
  invertZoom: boolean;
  zoomSpeed: number;
  orbitSpeed: number;
  orbitAroundSelection: boolean;
  zoomToCursor: boolean;
  gizmoSize: number;
  snapGrid: number;
  pickRadius: number;

  // editor
  editorVisible: boolean;
  editorFontSize: number;
  editorFontFamily: string;
  editorMinimap: boolean;
  editorWordWrap: boolean;
  editorStickyScroll: boolean;
  editorInlayLengths: boolean;
  editorSyncCursor: boolean;
  revealOnSelect: boolean;
  editorTabSize: number;
  editorRenderWhitespace: boolean;
  editorLineHighlight: boolean;
  editorHoverDelay: number;

  // editing
  decimals: number;
  autoSave: 'off' | 'onFocusChange' | 'afterDelay';
  autoSaveDelay: number;
  backupOnSave: boolean;
  backupCount: number;
  backupDir: string;
  confirmDelete: boolean;
  newRowsPosition: 'end' | 'afterSelection';
  deleteRelated: boolean;
  mirrorSuffixLeft: string;
  mirrorSuffixRight: string;
  mirrorTolerance: number;
  namingPrefix: string;
  namingStart: number;
  namingCenterTolerance: number;
  namingAutoMirror: boolean;

  // files
  gameDir: string;
  userDir: string;
  extraRoots: string[];
  loadCommonFolder: boolean;
  watchFiles: boolean;
  reloadOnExternalChange: 'merge' | 'ask' | 'always' | 'never';
  /** Reload in game starts BeamNG on this level (folder name) when it is not running */
  gameStartLevel: string;
  /** look for a new EditorNG release at startup */
  updateCheck: boolean;
  /** version the user chose to skip ("" = none) */
  updateSkip: string;

  // blender
  blenderExe: string;
  blenderAxis: 'z-up' | 'y-up';
  importMergeTolerance: number;
  importMakeTris: boolean;
  /** "authors" written into new parts */
  modAuthor: string;
  importMakeBeams: boolean;
  importUseGroups: boolean;
  linkPort: number;

  // suspension
  suspRigidThreshold: number;
  suspTravel: number;
  suspSteps: number;
  suspPartPattern: string;

  // debug
  debugShortBeam: number;
  debugCloseNodes: number;
  debugMinBeamsPerNode: number;

  keymap: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#ff6600',
  uiScale: 1,
  density: 'compact',
  reduceMotion: false,

  nodeSize: 10,
  nodeWorldScale: false,
  beamWidth: 1,
  triOpacity: 0.28,
  meshOpacity: 0.4,
  showMeshes: true,
  meshWireframe: false,
  meshShading: 'shaded',
  shadedEnvHdr: '',
  shadedEnvBrightness: 1,
  meshColorByPart: false,
  showNodes: true,
  showBeams: true,
  showTris: true,
  showTriNormals: false,
  showWheels: true,
  showProps: true,
  showOccupants: true,
  showRails: true,
  paletteVersion: 2,
  symmetryX: false,
  gizmo: 'none',
  showTriggers: true,
  selNodes: true,
  selBeams: true,
  selTris: true,
  selTriggers: true,
  selFlex: false,
  selProps: false,
  showGrid: true,
  showAxes: true,
  showGround: true,
  showLabels: 'hover',
  labelSize: 11,
  beamColorMode: 'type',
  colorNode: '#c5cad2',
  colorNodeFixed: '#d46a6a',
  colorBeam: '#6f8aa8',
  colorBeamAniso: '#9a88c4',
  colorBeamBounded: '#c9a066',
  colorBeamSupport: '#b04fd6',
  colorBeamHydro: '#6fb07a',
  colorBeamPressured: '#86a9c9',
  colorBeamLbeam: '#a8adb4',
  colorTri: '#5aa394',
  colorTriBack: '#b04fd6',
  colorSelect: '#ff6600',
  colorHighlight: '#d07ad0',
  dimOtherParts: true,
  dimOpacity: 0.12,
  xray: false,
  fov: 45,
  antialias: true,
  pixelRatioCap: 2,
  orbitButton: 'middle',
  frameOnScope: true,
  invertZoom: false,
  zoomSpeed: 1,
  orbitSpeed: 1,
  orbitAroundSelection: true,
  zoomToCursor: true,
  gizmoSize: 1,
  snapGrid: 0.01,
  pickRadius: 9,

  editorVisible: true,
  editorFontSize: 13,
  editorFontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  editorMinimap: true,
  editorWordWrap: false,
  editorStickyScroll: true,
  editorInlayLengths: false,
  editorSyncCursor: true,
  revealOnSelect: true,
  editorTabSize: 4,
  editorRenderWhitespace: false,
  editorLineHighlight: true,
  editorHoverDelay: 350,

  decimals: 3,
  autoSave: 'off',
  autoSaveDelay: 1500,
  backupOnSave: true,
  backupCount: 20,
  backupDir: '',
  confirmDelete: false,
  newRowsPosition: 'end',
  deleteRelated: true,
  mirrorSuffixLeft: 'l',
  mirrorSuffixRight: 'r',
  mirrorTolerance: 0.002,
  namingPrefix: 'n',
  namingStart: 1,
  namingCenterTolerance: 0.002,
  namingAutoMirror: true,

  gameDir: '',
  userDir: '',
  extraRoots: [],
  loadCommonFolder: true,
  watchFiles: true,
  reloadOnExternalChange: 'merge',
  gameStartLevel: 'smallgrid',
  updateCheck: true,
  updateSkip: '',

  blenderExe: '',
  blenderAxis: 'z-up',
  importMergeTolerance: 0.001,
  importMakeTris: true,
  modAuthor: '',
  importMakeBeams: true,
  importUseGroups: true,
  linkPort: 46790,

  suspRigidThreshold: 1_000_000,
  suspTravel: 0.1,
  suspSteps: 21,
  suspPartPattern: 'suspension|susp|hub|steer|knuckle|strut|coilover|shock|spring|swaybar|arm|axle|link|leaf|wishbone|trailing|spindle|upright|tierod|rack',

  debugShortBeam: 0.01,
  debugCloseNodes: 0.003,
  debugMinBeamsPerNode: 3,

  keymap: {},
};

interface SettingsStore {
  s: Settings;
  loaded: boolean;
  set: (patch: Partial<Settings>) => void;
  reset: (keys?: Array<keyof Settings>) => void;
  load: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(s: Settings) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const diff: Record<string, any> = {};
    for (const k in s) {
      const key = k as keyof Settings;
      if (JSON.stringify(s[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])) diff[k] = s[key];
    }
    api.settingsSave(diff).catch(() => {});
  }, 300);
}

export const useSettings = create<SettingsStore>((set, get) => ({
  s: DEFAULT_SETTINGS,
  loaded: false,
  set: (patch) => {
    const next = { ...get().s, ...patch };
    set({ s: next });
    scheduleSave(next);
  },
  reset: (keys) => {
    const next = { ...get().s };
    for (const k of keys ?? (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>)) (next as any)[k] = DEFAULT_SETTINGS[k];
    set({ s: next });
    scheduleSave(next);
  },
  load: async () => {
    const saved = (await api.settingsLoad().catch(() => ({}))) as Record<string, any>;
    const s = { ...DEFAULT_SETTINGS } as any;
    for (const k in saved) if (k in DEFAULT_SETTINGS) s[k] = saved[k];
    // 0.2 palette: colours still at the 0.1 defaults move to the new defaults (custom colours are kept)
    if ((saved.paletteVersion ?? 1) < 2) {
      for (const [k, old] of Object.entries(PALETTE_V1)) if (typeof s[k] === 'string' && s[k].toLowerCase() === old) s[k] = (DEFAULT_SETTINGS as any)[k];
    }
    s.paletteVersion = 2;
    set({ s, loaded: true });
  },
}));

export const settings = () => useSettings.getState().s;

/** 0.1 default colours (migrated to the 0.2 palette when unchanged) */
const PALETTE_V1: Record<string, string> = {"accent":"#ff7a1a","colorNode":"#f2c94c","colorNodeFixed":"#ff4d6d","colorBeam":"#55c1ff","colorBeamAniso":"#b98cff","colorBeamBounded":"#ffb454","colorBeamSupport":"#ff6f91","colorBeamHydro":"#4fe3a1","colorBeamPressured":"#9ad1ff","colorBeamLbeam":"#e0e0e0","colorTri":"#3ec7a8","colorSelect":"#ff7a1a","colorHighlight":"#ff4fd8"};

export function keyFor(action: string): string {
  const km = settings().keymap;
  return km[action] ?? DEFAULT_KEYMAP[action] ?? '';
}

/** Normalizes a keyboard event into "Ctrl+Shift+Alt+Key" form. */
export function eventKey(e: KeyboardEvent): string {
  let k = e.key;
  if (e.code.startsWith('Numpad')) {
    const map: Record<string, string> = { NumpadDecimal: 'Numpad.', NumpadAdd: 'Numpad+', NumpadSubtract: 'Numpad-', NumpadEnter: 'Enter' };
    k = map[e.code] ?? e.code;
  } else if (k.length === 1) {
    k = k.toUpperCase();
    if (e.code.startsWith('Digit')) k = e.code.slice(5);
  } else if (k === ' ') {
    k = 'Space';
  }
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return '';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey && !(k.length === 1 && !/[A-Z0-9]/.test(k))) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  parts.push(k);
  return parts.join('+');
}

export function matches(action: string, e: KeyboardEvent): boolean {
  const k = keyFor(action);
  return !!k && k === eventKey(e);
}
