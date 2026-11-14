/**
 * The single bar above the 3D view: scope breadcrumb, pick mode, views, the Display popover,
 * the two toggles used constantly (flexbodies, x-ray), symmetry and the inspector toggle.
 * Also the small overlays inside the view (stats, legend).
 */
import { useEffect, useState } from 'react';
import { Box, Ghost, Eye, FlipHorizontal2, PanelRight, ChevronDown } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useSettings, settings, type BeamColorMode, type Settings } from '../state/settings';
import { useSel, resolveSel, type PickMode } from '../state/selection';
import { useUi } from '../state/ui';
import { getViewport } from './ViewportPanel';
import { beamGroup, GROUPLESS, partColor } from './viewport';

const rgbCss = (c: number[]) => `rgb(${c.map((x) => Math.round(x * 255)).join(', ')})`;

const DISPLAY_TOGGLES: Array<[keyof Settings, string]> = [
  ['showNodes', 'Nodes'],
  ['showBeams', 'Beams'],
  ['showTris', 'Collision triangles'],
  ['showTriNormals', 'Triangle normals'],
  ['showMeshes', 'Flexbodies'],
  ['showOccupants', 'Occupants'],
  ['showProps', 'Props & lights'],
  ['showTriggers', 'Triggers'],
  ['showWheels', 'Wheels'],
  ['showRails', 'Rails & slidenodes'],
  ['meshColorByPart', 'Flexbodies coloured by part'],
  ['showGrid', 'Grid'],
  ['showAxes', 'Axes'],
  ['showGround', 'Ground plane'],
  ['xray', 'X-ray'],
];

/** what a plain click / box select may pick; Alt+click still reaches meshes, props and triggers */
const SELECTABLE: Array<[keyof Settings, string]> = [
  ['selNodes', 'Nodes'],
  ['selBeams', 'Beams'],
  ['selTris', 'Triangles'],
  ['selTriggers', 'Triggers'],
  ['selFlex', 'Flexbodies'],
  ['selProps', 'Props'],
];

export function ViewportBar() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const mode = useSel((x) => x.mode);
  const inspector = useUi((x) => x.inspector);
  const [display, setDisplay] = useState(false);
  const [ortho, setOrtho] = useState(false);
  useEffect(() => {
    if (!display) return;
    const close = () => setDisplay(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [display]);
  const seg = (m: PickMode, label: string, tip: string) => (
    <button className={'seg' + (mode === m ? ' active' : '')} onClick={() => useSel.setState({ mode: m })} data-tip={tip}>{label}</button>
  );
  const view = (label: string, tip: string, fn: () => void, active = false) => (
    <button className={'seg' + (active ? ' active' : '')} data-tip={tip} onClick={() => {
      fn();
      setOrtho(!!getViewport()?.isOrtho);
    }}>{label}</button>
  );
  const iconToggle = (key: keyof Settings, icon: React.ReactNode, tip: string) => (
    <button className={'icon-btn small' + (s[key] ? ' active' : '')} data-tip={tip} onClick={() => set({ [key]: !s[key] } as any)} aria-label={tip}>{icon}</button>
  );
  return (
    <div className="vp-bar" onPointerDown={(e) => e.stopPropagation()}>
      <ScopeCrumbs />
      <div className="sep-v bar-pick" />
      <div className="segmented small bar-pick">
        {seg('all', 'All', 'Pick anything')}
        {seg('nodes', 'Nodes', 'Nodes only (1)')}
        {seg('beams', 'Beams', 'Beams only (2)')}
        {seg('tris', 'Tris', 'Triangles only (3)')}
      </div>
      <div className="sep-v bar-views" />
      <div className="segmented small bar-views">
        {view('Persp', 'Perspective (Numpad 5 toggles ortho)', () => getViewport()?.setOrtho(false), !ortho)}
        {view('Top', 'Top (Numpad 7, Ctrl: bottom)', () => getViewport()?.setView('top'))}
        {view('Front', 'Front (Numpad 1, Ctrl: back)', () => getViewport()?.setView('front'))}
        {view('Side', 'Right side (Numpad 3, Ctrl: left)', () => getViewport()?.setView('right'))}
      </div>
      <div className="grow" />
      {iconToggle('showMeshes', <Box size={14} />, 'Flexbodies')}
      <div className="segmented small bar-shading" data-tip="Flexbody shading (Z cycles)">
        {(['wireframe', 'solid', 'shaded'] as const).map((m) => (
          <button key={m} className={'seg' + (s.meshShading === m && s.showMeshes ? ' active' : '')} onClick={() => set({ meshShading: m, showMeshes: true })}>
            {m === 'wireframe' ? 'Wire' : m === 'solid' ? 'Solid' : 'Shaded'}
          </button>
        ))}
      </div>
      {iconToggle('xray', <Ghost size={14} />, 'X-ray: nodes & beams through meshes (Alt+Z)')}
      <div className="vp-pop-wrap" onPointerDown={(e) => e.stopPropagation()}>
        <button className={'icon-btn small' + (display ? ' active' : '')} data-tip="Display: layers, sizes, colours" data-tip-pos="bottom-left" onClick={() => setDisplay(!display)} aria-label="Display options">
          <Eye size={14} /><ChevronDown size={11} />
        </button>
        {display && <DisplayPopover />}
      </div>
      <div className="sep-v" />
      <button className={'icon-btn small' + (s.symmetryX ? ' active' : '')} data-tip={'X symmetry (Shift+X)\nMoving a node also moves its mirror twin'} data-tip-pos="bottom-left" onClick={() => set({ symmetryX: !s.symmetryX })} aria-label="Symmetry">
        <FlipHorizontal2 size={14} />
      </button>
      <button className={'icon-btn small' + (inspector ? ' active' : '')} data-tip="Inspector" data-tip-pos="bottom-left" onClick={() => useUi.setState({ inspector: !inspector })} aria-label="Inspector">
        <PanelRight size={14} />
      </button>
    </div>
  );
}

function DisplayPopover() {
  const s = useSettings((x) => x.s);
  const set = useSettings((x) => x.set);
  const slider = (key: keyof Settings, label: string, min: number, max: number, step: number) => (
    <label className="disp-slider">
      <span className="dim">{label}</span>
      <input type="range" min={min} max={max} step={step} value={s[key] as number} onChange={(e) => set({ [key]: +e.target.value } as any)} />
      <span className="mono faint">{(s[key] as number).toFixed(step < 0.1 ? 2 : 1)}</span>
    </label>
  );
  return (
    <div className="menu-pop disp-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ctx-title">Show</div>
      <div className="disp-grid">
        {DISPLAY_TOGGLES.map(([k, label]) => (
          <label key={k} className="disp-check">
            <input type="checkbox" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as any)} />
            {label}
          </label>
        ))}
      </div>
      <div className="ctx-sep" />
      <div className="ctx-title" data-tip={'What a click or box select picks.\nAlt+click always picks flexbodies, props and triggers.'} data-tip-pos="bottom-right">Selectable</div>
      <div className="disp-grid">
        {SELECTABLE.map(([k, label]) => (
          <label key={k} className="disp-check">
            <input type="checkbox" checked={!!s[k]} onChange={(e) => set({ [k]: e.target.checked } as any)} />
            {label}
          </label>
        ))}
      </div>
      <div className="ctx-sep" />
      {slider('nodeSize', 'Node size', 2, 20, 0.5)}
      {slider('beamWidth', 'Beam width', 0.5, 6, 0.25)}
      {slider('meshOpacity', 'Flexbody opacity', 0, 1, 0.02)}
      {slider('triOpacity', 'Triangle opacity', 0, 1, 0.02)}
      {s.meshShading === 'shaded' && slider('shadedEnvBrightness', 'Light', 0.25, 3, 0.05)}
      <div className="ctx-sep" />
      <label className="disp-row">
        <span className="dim">Flexbodies</span>
        <select className="select small" value={s.meshShading} onChange={(e) => set({ meshShading: e.target.value as Settings['meshShading'] })}>
          <option value="wireframe">Wireframe</option>
          <option value="solid">Solid</option>
          <option value="shaded">Shaded</option>
        </select>
      </label>
      <label className="disp-row">
        <span className="dim">Labels</span>
        <select className="select small" value={s.showLabels} onChange={(e) => set({ showLabels: e.target.value as Settings['showLabels'] })}>
          <option value="off">Off</option>
          <option value="hover">Hovered</option>
          <option value="selected">Selected</option>
          <option value="all">All</option>
        </select>
      </label>
      <label className="disp-row">
        <span className="dim">Beam colours</span>
        <select className="select small" value={s.beamColorMode} onChange={(e) => set({ beamColorMode: e.target.value as BeamColorMode })}>
          <option value="type">By beam type</option>
          <option value="part">By part</option>
          <option value="deformGroup">By deform group</option>
          <option value="breakGroup">By break group</option>
          <option value="stiffness">By stiffness</option>
          <option value="uniform">Uniform</option>
        </select>
      </label>
    </div>
  );
}

/** Vehicle › file › part. Each crumb changes the scope; this is the main scope control. */
function ScopeCrumbs() {
  const scope = useSel((x) => x.scope);
  const v = useWs((x) => x.vehicle);
  const target = useWs((x) => x.target);
  if (!v) return <span className="crumb faint">No vehicle</span>;
  const fileName = (f: string) => f.slice(f.lastIndexOf('/') + 1);
  const files = [...new Set(v.parts.map((p) => p.def.file))].sort((a, b) => fileName(a).localeCompare(fileName(b)));
  const curFile = scope.mode === 'vehicle' ? '' : scope.file;
  const fileForParts = curFile || target?.doc || v.root?.def.file || '';
  // every part the file defines, installed or not (picking one that is not installed installs it)
  const installed = new Set(v.parts.filter((p) => p.def.file.toLowerCase() === fileForParts.toLowerCase()).map((p) => p.def.name));
  const defined = ws.doc(fileForParts)?.jfile?.parts.map((p) => p.name) ?? [];
  const parts = [...new Set([...defined, ...installed])].map((name) => ({ def: { name }, on: installed.has(name) }));
  const curPart = scope.mode === 'part' ? scope.part : '';
  return (
    <div className="crumbs">
      <button className={'crumb' + (scope.mode === 'vehicle' ? ' active' : '')} onClick={() => ws.setScope({ mode: 'vehicle' })} data-tip="Whole assembled vehicle">
        {ws.model ?? 'Vehicle'}
      </button>
      <span className="crumb-sep">›</span>
      <select className={'crumb-select' + (scope.mode === 'file' ? ' active' : '')} value={curFile} onChange={(e) => e.target.value && ws.setScope({ mode: 'file', file: e.target.value })} onKeyDown={(e) => e.stopPropagation()} data-tip="Show one file">
        <option value="">{scope.mode === 'vehicle' ? 'all files' : '—'}</option>
        {files.map((f) => <option key={f} value={f}>{fileName(f)}</option>)}
      </select>
      {scope.mode !== 'vehicle' && (
        <>
          <span className="crumb-sep">›</span>
          <select className={'crumb-select mono' + (scope.mode === 'part' ? ' active' : '')} value={curPart} onChange={(e) => (e.target.value ? ws.focusPart(e.target.value) : ws.setScope({ mode: 'file', file: fileForParts }))} onKeyDown={(e) => e.stopPropagation()} data-tip="Show one part (Shift+I)">
            <option value="">{parts.length} part{parts.length === 1 ? '' : 's'}{installed.size < parts.length ? ` (${installed.size} installed)` : ''}</option>
            {parts.map((p) => <option key={p.def.name} value={p.def.name}>{p.def.name}{p.on ? '' : '  (not installed)'}</option>)}
            {curPart && !parts.some((p) => p.def.name === curPart) && <option value={curPart}>{curPart}</option>}
          </select>
        </>
      )}
    </div>
  );
}

/** Bottom-left of the view: what is visible and what is selected (mockup style). */
export function ViewStats() {
  const v = useWs((x) => x.vehicle);
  const sel = useSel((x) => x.sel);
  const hiddenSet = useSel((x) => x.hidden);
  const active = useSel((x) => x.active);
  useSel((x) => x.scope);
  const vp = getViewport();
  if (!v || !vp) return null;
  let nodes = 0;
  for (let i = 0; i < vp.nodeVis.length; i++) if (vp.nodeVis[i] === 2) nodes++;
  const si = resolveSel(v, sel);
  const nSel = si.nodes.size + si.beams.size + si.tris.size + si.triggers.size + si.flex.size + si.props.size;
  let selText = '';
  if (nSel === 1 && si.nodes.size === 1) {
    const i = [...si.nodes][0];
    selText = `1 selected: ${v.nodes[i].name} · ${v.beams.filter((b) => b.a === i || b.b === i).length} beams`;
  } else if (nSel) selText = `${nSel} selected`;
  const hiddenN = hiddenSet.size;
  const measure = measureText(v, [...si.nodes], active);
  return (
    <div className="vp-stats">
      <div>{nodes} nodes · {vp.drawBeams.length} beams · {vp.drawTris.length} tris</div>
      {selText && <div>{selText}</div>}
      {measure && <div className="vp-measure">{measure}</div>}
      {hiddenN > 0 && <div>{hiddenN} hidden · Alt+H shows them</div>}
    </div>
  );
}

const TYPE_LEGEND: Array<[string, keyof Settings, string]> = [
  ['NORMAL', 'colorBeam', 'beam'],
  ['BOUNDED', 'colorBeamBounded', 'bounded'],
  ['SUPPORT', 'colorBeamSupport', 'support'],
  ['HYDRO', 'colorBeamHydro', 'hydro'],
  ['PRESSURED', 'colorBeamPressured', 'pressured'],
  ['ANISOTROPIC', 'colorBeamAniso', 'anisotropic'],
  ['LBEAM', 'colorBeamLbeam', 'l-beam'],
];

/** Top-right of the view: what the beam colours mean. */
export function ViewLegend() {
  const v = useWs((x) => x.vehicle);
  const s = useSettings((x) => x.s);
  const sel = useSel((x) => x.sel);
  useSel((x) => x.scope);
  const vp = getViewport();
  if (!v || !vp || !s.showBeams) return null;
  const items: Array<[string, string]> = [];
  if (s.beamColorMode === 'type') {
    const present = new Set(vp.drawBeams.map((i) => v.beams[i]?.type).filter(Boolean));
    for (const [t, key, label] of TYPE_LEGEND) if (present.has(t as any) || (t === 'NORMAL' && present.size === 0)) items.push([s[key] as string, label]);
  } else if (s.beamColorMode === 'stiffness') {
    items.push(['#3b5bdb', 'soft'], ['#e8590c', 'stiff']);
  } else if (s.beamColorMode === 'uniform') items.push([s.colorBeam, 'beam']);
  else if (s.beamColorMode === 'part') items.push(['', 'colour = part']);
  else {
    // the groups on screen, most beams first
    const kind = s.beamColorMode;
    const count = new Map<string, number>();
    for (const i of vp.drawBeams) {
      const g = beamGroup(v.beams[i].row.v, kind);
      if (g) count.set(g, (count.get(g) ?? 0) + 1);
    }
    const groups = [...count].sort((a, b) => b[1] - a[1]);
    for (const [g] of groups.slice(0, 10)) items.push([rgbCss(partColor(g)), g]);
    if (groups.length > 10) items.push(['', `+${groups.length - 10} more`]);
    items.push([GROUPLESS, groups.length ? `no ${kind}` : `no ${kind} here`]);
  }
  const si = resolveSel(v, sel);
  if (si.nodes.size === 1) items.push([s.colorSelect, `attached to ${v.nodes[[...si.nodes][0]].name}`]);
  else if (si.nodes.size > 1 && si.nodes.size <= 64) items.push([s.colorSelect, 'attached to selection']);
  return (
    <div className="vp-legend">
      {items.map(([c, l]) => (
        <span key={l}>{c && <i style={{ background: c }} />}{l}</span>
      ))}
    </div>
  );
}

export { settings };

/** 2 nodes: distance and per-axis deltas; 3 nodes: the angle at the active (or middle) node. */
export function measureText(v: { nodes: Array<{ name: string; x: number; y: number; z: number }> }, idx: number[], active: { kind: string; idx: number } | null): string | null {
  if (idx.length === 2) {
    const [a, b] = idx.map((i) => v.nodes[i]);
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    return `↔ ${d.toFixed(4)} m   Δx ${(b.x - a.x).toFixed(3)}  Δy ${(b.y - a.y).toFixed(3)}  Δz ${(b.z - a.z).toFixed(3)}`;
  }
  if (idx.length === 3) {
    const at = active?.kind === 'node' && idx.includes(active.idx) ? active.idx : idx[1];
    const [p, q] = idx.filter((i) => i !== at).map((i) => v.nodes[i]);
    const o = v.nodes[at];
    const u = [p.x - o.x, p.y - o.y, p.z - o.z], w = [q.x - o.x, q.y - o.y, q.z - o.z];
    const lu = Math.hypot(u[0], u[1], u[2]), lw = Math.hypot(w[0], w[1], w[2]);
    if (!lu || !lw) return null;
    const ang = (Math.acos(Math.max(-1, Math.min(1, (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (lu * lw)))) * 180) / Math.PI;
    return `∠ ${ang.toFixed(2)}° at ${o.name}`;
  }
  return null;
}
