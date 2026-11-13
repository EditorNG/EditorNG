import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search, RotateCcw, FolderOpen, Download, Upload, Keyboard } from 'lucide-react';
import { useUi } from '../state/ui';
import { useSettings, DEFAULT_SETTINGS, DEFAULT_KEYMAP, eventKey, type Settings } from '../state/settings';
import { api } from '../lib/api';
import { toast } from '../state/toast';
import { ws } from '../project/workspace';
import { meshes } from '../scene/meshes';
import { ACTION_LABELS } from './Dialogs';

type K = keyof Settings;
type Field =
  | { key: K; label: string; type: 'bool'; hint?: string }
  | { key: K; label: string; type: 'number' | 'range'; min?: number; max?: number; step?: number; hint?: string; unit?: string }
  | { key: K; label: string; type: 'select'; options: Array<[string, string]>; hint?: string }
  | { key: K; label: string; type: 'color'; hint?: string }
  | { key: K; label: string; type: 'text'; hint?: string; mono?: boolean }
  | { key: K; label: string; type: 'path'; dir?: boolean; hint?: string; filters?: Array<{ name: string; extensions: string[] }> }
  | { key: K; label: string; type: 'list'; hint?: string };

interface Group {
  id: string;
  title: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    id: 'appearance', title: 'Appearance', fields: [
      { key: 'theme', label: 'Theme', type: 'select', options: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Follow Windows']] },
      { key: 'accent', label: 'Accent colour', type: 'color' },
      { key: 'uiScale', label: 'UI scale', type: 'range', min: 0.8, max: 1.4, step: 0.05 },
      { key: 'density', label: 'Density', type: 'select', options: [['compact', 'Compact'], ['comfortable', 'Comfortable']] },
      { key: 'reduceMotion', label: 'Reduce motion', type: 'bool' },
    ],
  },
  {
    id: 'viewport', title: '3D view', fields: [
      { key: 'nodeSize', label: 'Node size', type: 'range', min: 2, max: 20, step: 0.5 },
      { key: 'nodeWorldScale', label: 'Scale nodes with distance', type: 'bool', hint: 'Off: constant pixel size. On: nodes shrink with distance like real spheres.' },
      { key: 'beamWidth', label: 'Beam width (px)', type: 'range', min: 0.5, max: 6, step: 0.25 },
      { key: 'triOpacity', label: 'Triangle opacity', type: 'range', min: 0, max: 1, step: 0.02 },
      { key: 'showTriNormals', label: 'Show triangle normals', type: 'bool', hint: 'Back faces are also tinted red, to spot flipped collision triangles.' },
      { key: 'meshOpacity', label: 'Flexbody opacity', type: 'range', min: 0, max: 1, step: 0.02 },
      { key: 'meshShading', label: 'Flexbody shading', type: 'select', options: [['wireframe', 'Wireframe: see-through with wire overlay (opacity above)'], ['solid', 'Solid: opaque grey-white'], ['shaded', 'Shaded: game materials (PBR, textures)']], hint: 'Z in the 3D view cycles the three.' },
      { key: 'shadedEnvHdr', label: 'Shaded: environment (.hdr / .exr)', type: 'path', filters: [{ name: 'HDR images', extensions: ['hdr', 'exr'] }, { name: 'All files', extensions: ['*'] }], hint: 'Equirectangular .hdr or .exr used for lighting and reflections in Shaded. Empty: built-in studio. Its brightness is normalised, so any HDRI works.' },
      { key: 'shadedEnvBrightness', label: 'Shaded: environment brightness', type: 'range', min: 0.25, max: 3, step: 0.05 },
      { key: 'meshColorByPart', label: 'Colour flexbodies by part', type: 'bool' },
      { key: 'showOccupants', label: 'Show occupants (0.40 seat occupants)', type: 'bool', hint: 'Torso and head placed like in game: seat nodeMove / nodeRotate applied.' },
      { key: 'showLabels', label: 'Node labels', type: 'select', options: [['off', 'Off'], ['hover', 'Hovered & selected'], ['selected', 'Selected only'], ['all', 'All']] },
      { key: 'labelSize', label: 'Label size', type: 'range', min: 8, max: 18, step: 1 },
      { key: 'beamColorMode', label: 'Beam colours', type: 'select', options: [['type', 'By beam type'], ['part', 'By part'], ['stiffness', 'By stiffness (heat map)'], ['deformGroup', 'By deform group'], ['uniform', 'Uniform']] },
      { key: 'dimOtherParts', label: 'Dim other parts when isolating', type: 'bool' },
      { key: 'dimOpacity', label: 'Dimmed opacity', type: 'range', min: 0, max: 0.6, step: 0.02 },
      { key: 'showGrid', label: 'Grid', type: 'bool' },
      { key: 'showAxes', label: 'Axes', type: 'bool' },
      { key: 'showGround', label: 'Ground plane', type: 'bool' },
      { key: 'fov', label: 'Field of view', type: 'range', min: 20, max: 90, step: 1, unit: '°' },
      { key: 'antialias', label: 'Anti-aliasing (restart)', type: 'bool' },
      { key: 'pixelRatioCap', label: 'Max pixel ratio', type: 'range', min: 1, max: 3, step: 0.25, hint: 'Lower for speed on 4K screens.' },
      { key: 'pickRadius', label: 'Click tolerance (px)', type: 'range', min: 3, max: 20, step: 1 },
    ],
  },
  {
    id: 'colors', title: 'Colours', fields: [
      { key: 'colorNode', label: 'Nodes', type: 'color' },
      { key: 'colorNodeFixed', label: 'Fixed nodes', type: 'color' },
      { key: 'colorBeam', label: 'Normal beams', type: 'color' },
      { key: 'colorBeamAniso', label: 'Anisotropic beams', type: 'color' },
      { key: 'colorBeamBounded', label: 'Bounded beams', type: 'color' },
      { key: 'colorBeamSupport', label: 'Support beams', type: 'color' },
      { key: 'colorBeamHydro', label: 'Hydros', type: 'color' },
      { key: 'colorBeamPressured', label: 'Pressured beams', type: 'color' },
      { key: 'colorBeamLbeam', label: 'L-beams', type: 'color' },
      { key: 'colorTri', label: 'Triangles', type: 'color' },
      { key: 'colorSelect', label: 'Selection', type: 'color' },
      { key: 'colorHighlight', label: 'Code cursor highlight', type: 'color' },
    ],
  },
  {
    id: 'controls', title: 'Camera & mouse', fields: [
      { key: 'orbitButton', label: 'Mouse layout', type: 'select', options: [['middle', 'Blender: MMB orbit, Shift+MMB pan, LMB select, RMB menu'], ['right', 'RMB orbit, MMB pan']] },
      { key: 'frameOnScope', label: 'Frame the view when picking a part / file', type: 'bool' },
      { key: 'zoomSpeed', label: 'Zoom speed', type: 'range', min: 0.2, max: 3, step: 0.1 },
      { key: 'invertZoom', label: 'Invert zoom', type: 'bool' },
      { key: 'zoomToCursor', label: 'Zoom towards cursor', type: 'bool' },
      { key: 'orbitSpeed', label: 'Orbit speed', type: 'range', min: 0.2, max: 3, step: 0.1 },
      { key: 'snapGrid', label: 'Snap step (Ctrl while moving)', type: 'number', step: 0.001, unit: 'm' },
    ],
  },
  {
    id: 'editor', title: 'Code editor', fields: [
      { key: 'editorVisible', label: 'Show code editor', type: 'bool' },
      { key: 'editorFontSize', label: 'Font size', type: 'range', min: 9, max: 22, step: 1 },
      { key: 'editorFontFamily', label: 'Font family', type: 'text', mono: true },
      { key: 'editorMinimap', label: 'Minimap', type: 'bool' },
      { key: 'editorWordWrap', label: 'Word wrap', type: 'bool' },
      { key: 'editorStickyScroll', label: 'Sticky part/section headers', type: 'bool' },
      { key: 'editorInlayLengths', label: 'Show beam lengths inline', type: 'bool' },
      { key: 'editorSyncCursor', label: 'Highlight cursor rows in 3D', type: 'bool' },
      { key: 'revealOnSelect', label: 'Jump to code when clicking in 3D', type: 'bool' },
      { key: 'editorTabSize', label: 'Tab size', type: 'number', min: 1, max: 8, step: 1 },
      { key: 'editorRenderWhitespace', label: 'Render whitespace', type: 'bool' },
      { key: 'editorLineHighlight', label: 'Highlight current line', type: 'bool' },
      { key: 'editorHoverDelay', label: 'Hover delay', type: 'number', min: 0, max: 2000, step: 50, unit: 'ms' },
    ],
  },
  {
    id: 'editing', title: 'Editing', fields: [
      { key: 'decimals', label: 'Coordinate decimals', type: 'number', min: 1, max: 6, step: 1, hint: 'Precision written for node positions and generated values.' },
      { key: 'autoSave', label: 'Auto save', type: 'select', options: [['off', 'Off'], ['onFocusChange', 'When the code editor loses focus']] },
      { key: 'backupOnSave', label: 'Back up files before saving', type: 'bool' },
      { key: 'backupCount', label: 'Backups kept per file', type: 'number', min: 1, max: 500, step: 1 },
      { key: 'backupDir', label: 'Backup folder', type: 'path', dir: true, hint: 'Empty = EditorNG data folder.' },
      { key: 'confirmDelete', label: 'Confirm before deleting', type: 'bool' },
      { key: 'deleteRelated', label: 'Deleting nodes also deletes their beams & triangles', type: 'bool' },
      { key: 'mirrorSuffixLeft', label: 'Left (+X) suffix', type: 'text', mono: true },
      { key: 'mirrorSuffixRight', label: 'Right (−X) suffix', type: 'text', mono: true },
      { key: 'mirrorTolerance', label: 'Mirror tolerance', type: 'number', step: 0.0005, unit: 'm' },
      { key: 'namingPrefix', label: 'Default node prefix', type: 'text', mono: true },
      { key: 'namingStart', label: 'Default start number', type: 'number', min: 0, step: 1 },
      { key: 'namingCenterTolerance', label: 'Centre-line tolerance (no suffix)', type: 'number', step: 0.0005, unit: 'm' },
    ],
  },
  {
    id: 'files', title: 'Files & game', fields: [
      { key: 'gameDir', label: 'BeamNG install folder', type: 'path', dir: true, hint: 'Auto-detected from BeamNG.drive.ini when empty.' },
      { key: 'userDir', label: 'BeamNG user folder', type: 'path', dir: true, hint: 'e.g. %LOCALAPPDATA%\\BeamNG\\BeamNG.drive\\current' },
      { key: 'extraRoots', label: 'Extra mod folders', type: 'list', hint: 'Folders containing vehicles/<name>, searched before the game.' },
      { key: 'loadCommonFolder', label: 'Load vehicles/common', type: 'bool', hint: 'Needed for common parts, wheels, seats, bulbs...' },
      { key: 'watchFiles', label: 'Watch files for external changes', type: 'bool' },
      { key: 'reloadOnExternalChange', label: 'On external change', type: 'select', options: [['ask', 'Reload unless I have unsaved edits'], ['always', 'Always reload'], ['never', 'Ignore']] },
    ],
  },
  {
    id: 'blender', title: 'Blender', fields: [
      { key: 'blenderExe', label: 'blender.exe', type: 'path', hint: 'Used to read .blend files and install the live-link add-on.' },
      { key: 'blenderAxis', label: 'OBJ files are', type: 'select', options: [['z-up', 'Z up (export with "Up: Z", "Forward: Y")'], ['y-up', 'Y up (Blender default OBJ export)']] },
      { key: 'importMergeTolerance', label: 'Weld / match tolerance', type: 'number', step: 0.0005, unit: 'm' },
      { key: 'importMakeBeams', label: 'Edges become beams', type: 'bool' },
      { key: 'importMakeTris', label: 'Faces become collision triangles', type: 'bool' },
      { key: 'linkPort', label: 'Live link port', type: 'number', min: 1024, max: 65535, step: 1 },
    ],
  },
  {
    id: 'analysis', title: 'Checks & suspension', fields: [
      { key: 'debugShortBeam', label: 'Short beam threshold', type: 'number', step: 0.001, unit: 'm' },
      { key: 'debugCloseNodes', label: 'Coincident node distance', type: 'number', step: 0.0005, unit: 'm' },
      { key: 'debugMinBeamsPerNode', label: 'Min beams per node', type: 'number', min: 1, max: 10, step: 1 },
      { key: 'suspRigidThreshold', label: 'Rigid beam threshold', type: 'number', step: 100000, unit: 'N/m', hint: 'Beams softer than this are treated as springs (ignored by the kinematics).' },
      { key: 'suspTravel', label: 'Sweep travel (±)', type: 'number', step: 0.01, unit: 'm' },
      { key: 'suspSteps', label: 'Sweep steps', type: 'number', min: 3, max: 61, step: 2 },
      { key: 'suspPartPattern', label: 'Moving parts pattern', type: 'text', mono: true },
    ],
  },
];

export default function SettingsPage() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const reset = useSettings((x) => x.reset);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('appearance');
  const ql = q.toLowerCase();
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, fields: g.fields.filter((f) => !ql || f.label.toLowerCase().includes(ql) || String(f.key).toLowerCase().includes(ql) || (f.hint ?? '').toLowerCase().includes(ql)) })), [ql]);
  const shown = q ? groups.filter((g) => g.fields.length) : groups.filter((g) => g.id === group);

  // side effects that need the main process
  useEffect(() => {
    const t = setTimeout(async () => {
      const roots = await api.configureRoots({ gameDir: s.gameDir || undefined, userDir: s.userDir || undefined, extraRoots: s.extraRoots });
      void roots;
      ws.refreshVehicleList();
    }, 600);
    return () => clearTimeout(t);
  }, [s.gameDir, s.userDir, s.extraRoots.join('|')]);
  useEffect(() => {
    api.blenderLinkPort(s.linkPort).catch(() => {});
  }, [s.linkPort]);

  return (
    <div className="page-inner settings">
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <button className="icon-btn" onClick={() => useUi.setState({ page: 'workbench' })} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="page-title">Settings</div>
        <div className="grow" />
        <div className="search-box" style={{ width: 280, margin: 0 }}>
          <Search size={13} className="faint" />
          <input className="input small" autoFocus placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <button className="btn small" onClick={async () => {
          const p = await api.saveDialog({ title: 'Export settings', defaultPath: 'editorng-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (p) {
            await api.writeTextFile(p, JSON.stringify(s, null, 2));
            toast('ok', 'Settings exported');
          }
        }}><Download size={13} /> Export</button>
        <button className="btn small" onClick={async () => {
          const p = await api.pickFile({ title: 'Import settings', filters: [{ name: 'JSON', extensions: ['json'] }] });
          if (!p) return;
          try {
            const j = JSON.parse(await api.readTextFile(p));
            const patch: Record<string, any> = {};
            for (const k in j) if (k in DEFAULT_SETTINGS) patch[k] = j[k];
            set(patch as Partial<Settings>);
            toast('ok', `Imported ${Object.keys(patch).length} settings`);
          } catch (e: any) {
            toast('error', 'Invalid settings file');
          }
        }}><Upload size={13} /> Import</button>
      </div>
      <div className="settings-grid">
        <nav className="settings-nav">
          {GROUPS.map((g) => (
            <button key={g.id} className={'list-item' + (!q && group === g.id ? ' active' : '')} onClick={() => { setQ(''); setGroup(g.id); }}>{g.title}</button>
          ))}
          <button className={'list-item' + (!q && group === 'keymap' ? ' active' : '')} onClick={() => { setQ(''); setGroup('keymap'); }}><Keyboard size={13} /> Keymap</button>
        </nav>
        <div className="settings-body">
          {(!q && group === 'keymap') || (q && Object.values(ACTION_LABELS).some((l) => l.toLowerCase().includes(ql))) ? <Keymap q={ql} /> : null}
          {shown.map((g) => (
            <section key={g.id} className="card settings-card">
              <div className="card-title">
                {g.title}
                <div className="grow" />
                <button className="btn small ghost" onClick={() => reset(g.fields.map((f) => f.key))}><RotateCcw size={12} /> Reset section</button>
              </div>
              {g.fields.map((f) => <FieldRow key={String(f.key)} f={f} />)}
            </section>
          ))}
          {!q && group !== 'keymap' && (
            <div className="faint small-text" style={{ padding: '4px 4px 20px' }}>
              Settings save automatically and carry over to the next session. Data folder: <span className="mono">EditorNG</span> in %APPDATA%.{' '}
              <button className="btn small ghost" onClick={async () => { await api.cacheClear(); meshes.clearGeometry(); toast('ok', 'Mesh cache cleared'); }}>Clear mesh cache</button>
              <button className="btn small ghost danger" onClick={() => { if (confirm('Reset every setting to its default?')) reset(); }}>Reset everything</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ f }: { f: Field }) {
  const v = useSettings((x) => x.s[f.key]);
  const set = useSettings((x) => x.set);
  const changed = JSON.stringify(v) !== JSON.stringify(DEFAULT_SETTINGS[f.key]);
  const upd = (val: any) => set({ [f.key]: val } as Partial<Settings>);
  let control: React.ReactNode = null;
  switch (f.type) {
    case 'bool':
      control = <button className={'switch' + (v ? ' on' : '')} onClick={() => upd(!v)} aria-label={f.label} aria-pressed={!!v} />;
      break;
    case 'range':
      control = (
        <div className="row" style={{ gap: 8 }}>
          <input type="range" min={f.min} max={f.max} step={f.step} value={v as number} onChange={(e) => upd(+e.target.value)} style={{ width: 180 }} />
          <span className="mono" style={{ width: 52, textAlign: 'right' }}>{+(v as number).toFixed(2)}{f.unit ?? ''}</span>
        </div>
      );
      break;
    case 'number':
      control = (
        <div className="row" style={{ gap: 6 }}>
          <input className="input small mono" type="number" min={f.min} max={f.max} step={f.step} value={v as number} onChange={(e) => upd(e.target.value === '' ? 0 : +e.target.value)} style={{ width: 120 }} />
          {f.unit && <span className="faint">{f.unit}</span>}
        </div>
      );
      break;
    case 'select':
      control = (
        <select className="select small" value={v as string} onChange={(e) => upd(e.target.value)}>
          {f.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
        </select>
      );
      break;
    case 'color':
      control = (
        <div className="row" style={{ gap: 8 }}>
          <input type="color" value={v as string} onChange={(e) => upd(e.target.value)} aria-label={f.label} />
          <span className="mono faint">{v as string}</span>
        </div>
      );
      break;
    case 'text':
      control = <input className={'input small' + (f.mono ? ' mono' : '')} value={v as string} onChange={(e) => upd(e.target.value)} style={{ width: 320 }} />;
      break;
    case 'path':
      control = (
        <div className="row" style={{ gap: 6 }}>
          <input className="input small mono" value={v as string} onChange={(e) => upd(e.target.value)} style={{ width: 340 }} />
          <button className="btn small" onClick={async () => {
            const p = f.dir ? await api.pickFolder(f.label, (v as string) || undefined) : await api.pickFile({ title: f.label, defaultPath: (v as string) || undefined, filters: f.filters });
            if (p) upd(p);
          }}><FolderOpen size={13} /></button>
        </div>
      );
      break;
    case 'list': {
      const list = v as string[];
      control = (
        <div className="col" style={{ gap: 4 }}>
          {list.map((item, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input className="input small mono" value={item} onChange={(e) => upd(list.map((x, j) => (j === i ? e.target.value : x)))} style={{ width: 340 }} />
              <button className="btn small ghost" onClick={() => upd(list.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={async () => {
            const p = await api.pickFolder('Add a mod folder');
            if (p) upd([...list, p]);
          }}><FolderOpen size={13} /> Add folder</button>
        </div>
      );
      break;
    }
  }
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{f.label}{changed && <span className="changed-dot" title="Changed from default" />}</span>
        {f.hint && <span className="field-hint">{f.hint}</span>}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}

function Keymap({ q }: { q: string }) {
  const km = useSettings((x) => x.s.keymap);
  const set = useSettings((x) => x.set);
  const [capture, setCapture] = useState<string | null>(null);
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setCapture(null);
      const k = eventKey(e);
      if (!k) return;
      set({ keymap: { ...km, [capture]: k } });
      setCapture(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture, km]);
  const ids = Object.keys(DEFAULT_KEYMAP).filter((id) => !q || (ACTION_LABELS[id] ?? id).toLowerCase().includes(q) || id.includes(q));
  const effective = (id: string) => km[id] ?? DEFAULT_KEYMAP[id];
  const conflicts = new Map<string, number>();
  for (const id of Object.keys(DEFAULT_KEYMAP)) conflicts.set(effective(id), (conflicts.get(effective(id)) ?? 0) + 1);
  return (
    <section className="card settings-card">
      <div className="card-title">Keymap<div className="grow" /><button className="btn small ghost" onClick={() => set({ keymap: {} })}><RotateCcw size={12} /> Reset all</button></div>
      {ids.map((id) => {
        const k = effective(id);
        const dup = (conflicts.get(k) ?? 0) > 1;
        return (
          <div key={id} className="setting-row">
            <div className="setting-label"><span>{ACTION_LABELS[id] ?? id}</span><span className="field-hint mono">{id}</span></div>
            <div className="setting-control row" style={{ gap: 6 }}>
              <button className={'btn small mono' + (capture === id ? ' primary' : '')} style={{ minWidth: 120 }} onClick={() => setCapture(id)}>{capture === id ? 'press keys…' : k || '—'}</button>
              {dup && <span className="warn-text small-text" title="Same key as another action; the viewport tool handler wins">shared</span>}
              {km[id] && <button className="icon-btn small" onClick={() => { const n = { ...km }; delete n[id]; set({ keymap: n }); }} aria-label="Reset"><RotateCcw size={12} /></button>}
            </div>
          </div>
        );
      })}
    </section>
  );
}
