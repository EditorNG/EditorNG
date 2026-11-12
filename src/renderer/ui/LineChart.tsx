import { useMemo, useRef, useState } from 'react';

/**
 * Small SVG line chart: one y-axis, 2px lines, recessive grid, legend + direct end labels,
 * crosshair + tooltip on hover. Colours: categorical slot 1 (blue) / slot 2 (orange) for series,
 * neutral dashed for references.
 */
export interface Series {
  name: string;
  values: number[];
  color: string;
  dashed?: boolean;
}

export const SERIES_COLORS = { light: ['#2a78d6', '#eb6834'], dark: ['#3987e5', '#d95926'] };

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(10));
  return out;
}

export function LineChart(props: {
  title: string;
  x: number[];
  xLabel: string;
  yLabel: string;
  series: Series[];
  height?: number;
  xFmt?: (x: number) => string;
  yFmt?: (y: number) => string;
  zeroLine?: boolean;
}) {
  const { x, series } = props;
  const W = 420, H = props.height ?? 190;
  const m = { l: 44, r: 54, t: 10, b: 28 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const yFmt = props.yFmt ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)));
  const xFmt = props.xFmt ?? ((v: number) => v.toFixed(3));

  const { xs, ys, yTicks, xTicks, y0, y1 } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const v of s.values) if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (props.zeroLine) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (!Number.isFinite(lo)) {
      lo = -1;
      hi = 1;
    }
    const pad = (hi - lo) * 0.08 || 0.5;
    const yt = niceTicks(lo - pad, hi + pad, 4);
    const ya = Math.min(yt[0], lo), yb = Math.max(yt[yt.length - 1], hi);
    const xa = Math.min(...x), xb = Math.max(...x);
    const xs = (v: number) => m.l + ((v - xa) / (xb - xa || 1)) * (W - m.l - m.r);
    const ys = (v: number) => H - m.b - ((v - ya) / (yb - ya || 1)) * (H - m.t - m.b);
    return { xs, ys, yTicks: yt, xTicks: niceTicks(xa, xb, 4), y0: ya, y1: yb };
  }, [x, series, H]);

  const path = (vals: number[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${xs(x[i]).toFixed(1)},${ys(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    x.forEach((xv, i) => {
      const d = Math.abs(xs(xv) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  // direct end labels, de-overlapped
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && !Number.isFinite(s.values[i])) i--;
      return i >= 0 ? { s, y: ys(s.values[i]) } : null;
    })
    .filter(Boolean) as Array<{ s: Series; y: number }>;
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;

  return (
    <figure className="chart">
      <figcaption className="chart-title">
        <span>{props.title}</span>
        {series.length > 1 && (
          <span className="chart-legend">
            {series.map((s) => (
              <span key={s.name} className="legend-item">
                <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} /></svg>
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart-svg" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={props.title}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={ys(t)} y2={ys(t)} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
            <text x={m.l - 6} y={ys(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{yFmt(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={xs(t)} y={H - m.b + 14} className="chart-tick" textAnchor="middle">{xFmt(t)}</text>
        ))}
        <text x={(m.l + W - m.r) / 2} y={H - 2} className="chart-axis-label" textAnchor="middle">{props.xLabel}</text>
        <text x={10} y={(m.t + H - m.b) / 2} className="chart-axis-label" textAnchor="middle" transform={`rotate(-90 10 ${(m.t + H - m.b) / 2})`}>{props.yLabel}</text>
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
        ))}
        {ends.map((e) => (
          <text key={e.s.name} x={W - m.r + 6} y={e.y} className="chart-end-label" dominantBaseline="middle">{e.s.name}</text>
        ))}
        {hover !== null && (
          <g>
            <line x1={xs(x[hover])} x2={xs(x[hover])} y1={m.t} y2={H - m.b} className="chart-crosshair" />
            {series.map((s) => Number.isFinite(s.values[hover]) && (
              <circle key={s.name} cx={xs(x[hover])} cy={ys(s.values[hover])} r={4} fill={s.color} stroke="var(--bg-2)" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} fill="transparent" />
        <desc>{`${props.yLabel} from ${y0.toFixed(2)} to ${y1.toFixed(2)}`}</desc>
      </svg>
      {hover !== null && (
        <div className="chart-tip">
          <div className="chart-tip-x">{props.xLabel}: {xFmt(x[hover])}</div>
          {series.map((s) => (
            <div key={s.name} className="chart-tip-row">
              <span className="chart-swatch" style={{ background: s.color }} />
              <span>{s.name}</span>
              <span className="mono">{Number.isFinite(s.values[hover]) ? yFmt(s.values[hover]) : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
