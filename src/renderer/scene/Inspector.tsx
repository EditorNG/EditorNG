import { useState, useEffect } from 'react';
import { Code2, Crosshair, ChevronDown, ChevronRight } from 'lucide-react';
import { ws, useWs } from '../project/workspace';
import { useSel, resolveSel, selNodeIdx } from '../state/selection';
import { revealRange } from '../editor/CodeEditor';
import * as ops from '../project/ops';
import { getViewport, getLayers, startRailSlide } from './ViewportPanel';
import { closestOnRail, pointAtS, railLength } from '@core/jbeam/rails';
import type { Row } from '@core/jbeam/types';
import { triggerName, triggerActions } from '@core/jbeam/triggers';
import { getNodeXform, invertNodeXform } from '@core/jbeam/nodeTransform';

function NumField(props: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean; step?: number; color?: string }) {
  const [text, setText] = useState(props.value.toFixed(4));
  useEffect(() => setText(props.value.toFixed(4)), [props.value]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v) && Math.abs(v - props.value) > 1e-9) props.onCommit(v);
    else setText(props.value.toFixed(4));
  };
  return (
    <label className="num-field">
      <span style={{ color: props.color }}>{props.label}</span>
      <input
        className="input small mono"
        value={text}
        disabled={props.disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const step = (props.step ?? 0.001) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            props.onCommit(props.value + step);
          }
        }}
      />
    </label>
  );
}

const OPT_KEYS = ['nodeWeight', 'collision', 'selfCollision', 'frictionCoef', 'nodeMaterial', 'group', 'beamSpring', 'beamDamp', 'beamDeform', 'beamStrength', 'beamType', 'deformGroup', 'breakGroup', 'beamPrecompression', 'beamLongBound', 'beamShortBound', 'deformLimitExpansion'];

function RowOptions({ row }: { row: Row }) {
  const keys = OPT_KEYS.filter((k) => row.v[k] !== undefined && row.v[k] !== '');
  if (!keys.length) return null;
  return (
    <div className="insp-opts">
      {keys.map((k) => {
        const val = row.v[k];
        const shown = typeof val === 'number' ? (Number.isFinite(val) ? String(+val.toPrecision(6)) : 'FLT_MAX') : JSON.stringify(val);
        return (
          <div key={k} className="insp-opt">
            <span className="dim">{k}</span>
            <span className="mono ellipsis" title={shown}>{shown}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Inspector() {
  const v = useWs((x) => x.vehicle);
  const sel = useSel((x) => x.sel);
  const [open, setOpen] = useState(true);
  if (!v) return null;
  const si = resolveSel(v, sel);
  const total = si.nodes.size + si.beams.size + si.tris.size + si.flex.size + si.props.size + si.triggers.size;
  if (!total) return null;

  let body: React.ReactNode = null;
  let title = '';
  let row: Row | null = null;
  if (total === 1 && si.nodes.size === 1) {
    const i = [...si.nodes][0];
    const n = v.nodes[i];
    row = n.row;
    title = n.name;
    const move = (k: 0 | 1 | 2, val: number) => {
      const p: [number, number, number] = [n.x, n.y, n.z];
      p[k] = val;
      ops.moveNodesSym(new Map([[i, p]]));
    };
    const editable = !!n.raw;
    body = (
      <>
        <div className="insp-xyz">
          <NumField label="X" color="#e5484d" value={n.x} onCommit={(x) => move(0, x)} disabled={!editable} />
          <NumField label="Y" color="#46a758" value={n.y} onCommit={(x) => move(1, x)} disabled={!editable} />
          <NumField label="Z" color="#3e8ef7" value={n.z} onCommit={(x) => move(2, x)} disabled={!editable} />
        </div>
        {n.raw && (n.raw[0] !== n.x || n.raw[1] !== n.y || n.raw[2] !== n.z) && (
          <div className="faint mono small-text">raw {n.raw.map((x) => x.toFixed(3)).join(', ')} (nodeOffset/Move applied)</div>
        )}
        {!editable && <div className="warn-text small-text">Position uses an expression; edit it in code.</div>}
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{n.row.part.def.name}</span></div>
        {n.groups.length > 0 && <div className="insp-line"><span className="dim">groups</span><span className="ellipsis">{n.groups.join(', ')}</span></div>}
        <div className="insp-line"><span className="dim">beams</span><span>{v.beams.filter((b) => b.a === i || b.b === i).length}</span></div>
        <RailInfo node={i} />
        <RowOptions row={n.row} />
      </>
    );
  } else if (total === 1 && si.beams.size === 1) {
    const b = v.beams[[...si.beams][0]];
    row = b.row;
    const A = v.nodes[b.a], B = v.nodes[b.b];
    title = `${A.name} — ${B.name}`;
    body = (
      <>
        <div className="insp-line"><span className="dim">length</span><span className="mono">{Math.hypot(A.x - B.x, A.y - B.y, A.z - B.z).toFixed(4)} m</span></div>
        <div className="insp-line"><span className="dim">type</span><span>{b.type.toLowerCase()} ({b.section})</span></div>
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{b.row.part.def.name}</span></div>
        <RowOptions row={b.row} />
      </>
    );
  } else if (total === 1 && si.tris.size === 1) {
    const t = v.tris[[...si.tris][0]];
    row = t.row;
    title = 'triangle';
    const A = v.nodes[t.a], B = v.nodes[t.b], C = v.nodes[t.c];
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z, wx = C.x - A.x, wy = C.y - A.y, wz = C.z - A.z;
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    body = (
      <>
        <div className="insp-line"><span className="dim">nodes</span><span className="mono">{A.name}, {B.name}, {C.name}</span></div>
        <div className="insp-line"><span className="dim">area</span><span className="mono">{(area * 1e4).toFixed(1)} cm²</span></div>
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{t.row.part.def.name}</span></div>
        <button className="btn small" onClick={() => ops.flipTris(si.tris)}>Flip normal</button>
      </>
    );
  } else if (total === 1 && si.flex.size === 1) {
    const f = v.flexbodies[[...si.flex][0]];
    row = f.row;
    title = f.mesh;
    body = (
      <>
        <div className="insp-line"><span className="dim">groups</span><span className="ellipsis">{f.groups.join(', ') || '—'}</span></div>
        <div className="insp-line"><span className="dim">nodes bound</span><span>{v.nodes.filter((n) => n.groups.some((g) => f.groups.includes(g))).length}</span></div>
        {f.pos && <div className="insp-line"><span className="dim">pos</span><span className="mono">{f.pos.map((x) => x.toFixed(3)).join(', ')}</span></div>}
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{f.row.part.def.name}</span></div>
      </>
    );
  } else if (total === 1 && si.triggers.size === 1) {
    const r = v.triggers[[...si.triggers][0]];
    row = r;
    title = triggerName(r) || 'trigger';
    const acts = triggerActions(v).get(String(r.v.id ?? '')) ?? [];
    const g = r.v.baseTranslationGlobal;
    const hasGlobal = g && typeof g === 'object';
    const bt = hasGlobal ? g : r.v.baseTranslation ?? { x: 0, y: 0, z: 0 };
    const key = hasGlobal ? 'baseTranslationGlobal' : 'baseTranslation';
    const setPos = (k: 'x' | 'y' | 'z', val: number) => {
      const nv = { x: +(bt.x ?? 0), y: +(bt.y ?? 0), z: +(bt.z ?? 0), [k]: val };
      if (hasGlobal) ops.setRowOptionFor(r, key, nv);
      else ops.setRowCell(r, key, nv);
    };
    const isSphere = r.v.type === 'sphere';
    const sz = r.v.size;
    const setSize = (k: 'x' | 'y' | 'z', val: number) => {
      if (isSphere || typeof sz === 'number') ops.setRowCell(r, 'size', val);
      else ops.setRowCell(r, 'size', { x: +(sz?.x ?? 0), y: +(sz?.y ?? 0), z: +(sz?.z ?? 0), [k]: val });
    };
    body = (
      <>
        <div className="faint small-text">{key} {hasGlobal ? '(vehicle coords)' : '(node frame)'} · ↑/↓ nudges 1 mm, Shift 1 cm</div>
        <div className="insp-xyz">
          <NumField label="X" color="#e5484d" value={+(bt.x ?? 0)} onCommit={(x) => setPos('x', x)} />
          <NumField label="Y" color="#46a758" value={+(bt.y ?? 0)} onCommit={(x) => setPos('y', x)} />
          <NumField label="Z" color="#3e8ef7" value={+(bt.z ?? 0)} onCommit={(x) => setPos('z', x)} />
        </div>
        <div className="faint small-text">{isSphere ? 'radius' : 'size (x, height, z)'}</div>
        {isSphere || typeof sz === 'number' ? (
          <div className="insp-xyz"><NumField label="r" value={+sz || 0} onCommit={(x) => setSize('x', x)} /></div>
        ) : (
          <div className="insp-xyz">
            <NumField label="X" value={+(sz?.x ?? 0)} onCommit={(x) => setSize('x', x)} />
            <NumField label="Y" value={+(sz?.y ?? 0)} onCommit={(x) => setSize('y', x)} />
            <NumField label="Z" value={+(sz?.z ?? 0)} onCommit={(x) => setSize('z', x)} />
          </div>
        )}
        <div className="insp-line"><span className="dim">nodes</span><span className="mono">{String(r.v['idRef:'])}, {String(r.v['idX:'])}, {String(r.v['idY:'])}</span></div>
        <div className="insp-line"><span className="dim">actions</span><span className="mono ellipsis" title={acts.join('\n')}>{acts.length ? acts.join(', ') : '— not linked —'}</span></div>
        {typeof r.v.label === 'string' && r.v.label && <div className="insp-line"><span className="dim">label</span><span className="ellipsis">{r.v.label}</span></div>}
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{r.part.def.name}</span></div>
        {!hasGlobal && <button className="btn small" onClick={() => {
          const shapes = getLayers()?.shapes ?? [];
          const sh = shapes.find((x) => x.row === r);
          // baseTranslationGlobal gets the row's nodeOffset/nodeMove/nodeRotate applied in game: write the raw value
          if (sh) {
            const raw = invertNodeXform(getNodeXform(r.v), sh.corner.x, sh.corner.y, sh.corner.z);
            ops.setRowOptionFor(r, 'baseTranslationGlobal', { x: +raw.x.toFixed(4), y: +raw.y.toFixed(4), z: +raw.z.toFixed(4) });
          }
        }}>Convert to global position</button>}
      </>
    );
  } else if (total === 1 && si.props.size === 1) {
    const p = v.props[[...si.props][0]];
    row = p.row;
    title = `${p.func || 'prop'} · ${p.mesh}`;
    const vec = (k: string) => {
      const o = p.row.v[k];
      return o && typeof o === 'object' ? { x: +(o.x ?? 0), y: +(o.y ?? 0), z: +(o.z ?? 0) } : { x: 0, y: 0, z: 0 };
    };
    const edit = (k: string, axis: 'x' | 'y' | 'z', val: number) => ops.setRowCell(p.row, k, { ...vec(k), [axis]: val });
    const fields = (k: string, step = 0.001) => (
      <div className="insp-xyz">
        {(['x', 'y', 'z'] as const).map((a, i) => (
          <NumField key={a} label={a.toUpperCase()} color={['#e5484d', '#46a758', '#3e8ef7'][i]} step={step} value={vec(k)[a]} onCommit={(x) => edit(k, a, x)} />
        ))}
      </div>
    );
    body = (
      <>
        <div className="faint small-text">baseTranslation (node frame, m)</div>
        {fields('baseTranslation')}
        <div className="faint small-text">baseRotation (°)</div>
        {fields('baseRotation', 1)}
        <div className="insp-line"><span className="dim">func</span><span className="mono">{p.func}</span></div>
        <div className="insp-line"><span className="dim">nodes</span><span className="mono ellipsis">{[p.idRef, p.idX, p.idY].map((i) => (i >= 0 ? v.nodes[i].name : '?')).join(', ')}</span></div>
        <div className="insp-line"><span className="dim">part</span><span className="ellipsis">{p.row.part.def.name}</span></div>
      </>
    );
  } else {
    const idx = [...selNodeIdx(v, si)];
    let cx = 0, cy = 0, cz = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const i of idx) {
      const n = v.nodes[i];
      cx += n.x; cy += n.y; cz += n.z;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
    }
    const k = idx.length || 1;
    title = `${total} selected`;
    body = (
      <>
        <div className="insp-line"><span className="dim">nodes / beams / tris</span><span>{si.nodes.size} / {si.beams.size} / {si.tris.size}</span></div>
        {idx.length > 0 && (
          <>
            <div className="insp-line"><span className="dim">centre</span><span className="mono">{(cx / k).toFixed(3)}, {(cy / k).toFixed(3)}, {(cz / k).toFixed(3)}</span></div>
            <div className="insp-line"><span className="dim">size</span><span className="mono">{(maxX - minX).toFixed(3)} × {(maxY - minY).toFixed(3)} × {(maxZ - minZ).toFixed(3)}</span></div>
          </>
        )}
        {si.nodes.size === 2 && (() => {
          const [a, b] = [...si.nodes].map((i) => v.nodes[i]);
          return <div className="insp-line"><span className="dim">distance</span><span className="mono">{Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toFixed(4)} m</span></div>;
        })()}
        <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          {si.nodes.size >= 2 && <button className="btn small" onClick={() => {
            const names = [...sel.nodes];
            if (names.length === 3) ops.addTris([[names[0], names[1], names[2]]]);
            else if (names.length === 2) ops.addBeams([[names[0], names[1]]]);
            else ops.addBeams(names.slice(1).map((n, i) => [names[i], n] as [string, string]), undefined, 'Connect chain');
          }}>{si.nodes.size === 3 ? 'Make triangle' : si.nodes.size === 2 ? 'Make beam' : 'Chain beams'} <span className="kbd">F</span></button>}
          <button className="btn small" onClick={() => ops.mirrorSelection()}>Mirror <span className="kbd">Ctrl+M</span></button>
        </div>
      </>
    );
  }

  return (
    <div className="inspector" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="insp-head">
        <button className="icon-btn small" onClick={() => setOpen(!open)} aria-label="Collapse">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <span className="insp-title ellipsis mono">{title}</span>
        {row && (
          <button className="icon-btn small" data-tip="Show in code" data-tip-pos="left" onClick={() => revealRange(row!.src.file, row!.src.node.s, row!.src.node.e, true)} aria-label="Show in code">
            <Code2 size={14} />
          </button>
        )}
        <button className="icon-btn small" data-tip="Frame (F)" data-tip-pos="left" onClick={() => getViewport()?.frameNodes([...selNodeIdx(v, si)])} aria-label="Frame">
          <Crosshair size={14} />
        </button>
      </div>
      {open && <div className="insp-body">{body}</div>}
    </div>
  );
}

/** Slidenode / rail membership of a node: rail, position along it, distance off it, snap & slide. */
function RailInfo({ node }: { node: number }) {
  const v = ws.vehicle;
  const vp = getViewport();
  if (!v || !vp) return null;
  const slide = vp.slides.find((x) => x.node === node);
  const onRails = [...vp.rails.values()].filter((r) => r.nodes.includes(node)).map((r) => r.name);
  if (!slide && !onRails.length) return null;
  const P = (i: number): [number, number, number] => [v.nodes[i].x, v.nodes[i].y, v.nodes[i].z];
  const rail = slide ? vp.rails.get(slide.rail) : undefined;
  const pts = rail ? rail.nodes.map(P) : [];
  const c = rail && pts.length >= 2 ? closestOnRail(pts, rail.looped, P(node)) : null;
  const len = rail ? railLength(pts, rail.looped) : 0;
  const tol = slide && typeof slide.row.v.tolerance === 'number' ? slide.row.v.tolerance : 0;
  return (
    <div className="insp-rail">
      {onRails.length > 0 && <div className="insp-line"><span className="dim">rail link of</span><span className="ellipsis mono">{onRails.join(', ')}</span></div>}
      {slide && (
        <>
          <div className="insp-line"><span className="dim">slidenode on</span><span className={'ellipsis mono' + (rail ? '' : ' warn-text')}>{slide.rail}{rail ? '' : ' (missing rail)'}</span></div>
          {c && (
            <>
              <div className="insp-xyz">
                <NumField label="s" value={c.s} step={0.005} onCommit={(sv) => ops.moveNodesSym(new Map([[node, pointAtS(pts, rail!.looped, sv)]]), 'Slide along rail')} />
                <span className="faint small-text mono" style={{ alignSelf: 'center' }}>/ {len.toFixed(3)} m</span>
              </div>
              <div className="insp-line">
                <span className="dim">off rail</span>
                <span className={'mono' + (c.dist > Math.max(tol, 0.002) ? ' warn-text' : '')}>{(c.dist * 1000).toFixed(1)} mm{tol ? ` (tolerance ${(tol * 1000).toFixed(0)} mm)` : ''}</span>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn small" disabled={c.dist < 1e-5} onClick={() => ops.snapToRails([node])} data-tip="Shift+R">Snap onto rail</button>
                <button className="btn small" onClick={() => startRailSlide()} data-tip="G G in the viewport">Slide along rail</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
