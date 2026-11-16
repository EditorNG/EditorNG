/**
 * Tooltips for every [data-tip] element: one floating layer above everything, so a tooltip is
 * never cut by a scrolling panel or a dialog, and always stays inside the window.
 * data-tip-pos picks the preferred side (bottom by default); it flips or shifts when there is no room.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY = 450;
const GAP = 6;
const MARGIN = 8;

interface Tip {
  text: string;
  rect: DOMRect;
  pos: string;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [xy, setXy] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cur: HTMLElement | null = null;
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      cur = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === cur) return;
      hide();
      if (!el || !el.dataset.tip) return;
      cur = el;
      timer = setTimeout(() => {
        if (cur !== el || !el.isConnected) return;
        setTip({ text: el.dataset.tip!, rect: el.getBoundingClientRect(), pos: el.dataset.tipPos ?? 'bottom' });
      }, DELAY);
    };
    window.addEventListener('mouseover', over, true);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('wheel', hide, true);
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      window.removeEventListener('mouseover', over, true);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // place it once its size is known
  useLayoutEffect(() => {
    if (!tip || !box.current) {
      setXy(null);
      return;
    }
    const w = box.current.offsetWidth, h = box.current.offsetHeight;
    const r = tip.rect, vw = window.innerWidth, vh = window.innerHeight;
    const side = tip.pos.startsWith('top') ? 'top' : tip.pos === 'left' ? 'left' : tip.pos === 'right' ? 'right' : 'bottom';
    let left: number, top: number;
    if (side === 'left' || side === 'right') {
      left = side === 'right' ? r.right + GAP : r.left - GAP - w;
      if (left + w > vw - MARGIN) left = r.left - GAP - w;
      if (left < MARGIN) left = r.right + GAP;
      top = r.top + r.height / 2 - h / 2;
    } else {
      top = side === 'top' ? r.top - GAP - h : r.bottom + GAP;
      if (top + h > vh - MARGIN) top = r.top - GAP - h;
      if (top < MARGIN) top = r.bottom + GAP;
      left = tip.pos.endsWith('-left') ? r.right - w : tip.pos.endsWith('-right') ? r.left : r.left + r.width / 2 - w / 2;
    }
    left = Math.min(Math.max(MARGIN, left), vw - w - MARGIN);
    top = Math.min(Math.max(MARGIN, top), vh - h - MARGIN);
    setXy({ left, top });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="tip-float" role="tooltip" style={xy ? { left: xy.left, top: xy.top } : { left: -9999, top: -9999 }}>
      {tip.text}
    </div>
  );
}
