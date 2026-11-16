/**
 * Beginner guide: short callouts pointing at real controls (never blocking them), one-time hints,
 * and longer tutorials whose steps can open files, show a section in the code and wait for the
 * user to do something. Everything can be skipped; Settings → Beginner tips turns it all off.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { X, Check } from 'lucide-react';
import { settings, useSettings } from '../state/settings';
import { toast } from '../state/toast';

export interface GuideStep {
  /** CSS selector of the control the step is about; none = a card at the bottom centre */
  target?: string;
  /** small label above the title ("Your files", "The JBeam file"…) */
  chapter?: string;
  title: string;
  /** paragraphs separated by blank lines; lines starting with "- " are a list; `code` */
  text: string;
  /** a wider card for longer explanations */
  wide?: boolean;
  /** runs when the step shows (open a file, show a section…) */
  enter?: () => void;
  /** something to do: the step waits for it (Skip moves on anyway) */
  task?: { text: string; done: () => boolean };
  /** buttons instead of Next / Done */
  choices?: Array<{ label: string; primary?: boolean; run: () => void }>;
}

interface GuideState {
  id: string | null;
  steps: GuideStep[];
  index: number;
  onEnd?: () => void;
}

const useGuide = create<GuideState>(() => ({ id: null, steps: [], index: 0 }));

export function tipsOn(): boolean {
  return settings().beginnerTips;
}

export function tipSeen(id: string): boolean {
  return settings().tipsSeen.includes(id);
}

export function markTipSeen(id: string) {
  const st = useSettings.getState();
  if (!st.s.tipsSeen.includes(id)) st.set({ tipsSeen: [...st.s.tipsSeen, id] });
}

/** Turns every guide and hint off (Settings → Beginner tips turns them back on). */
export function stopAllTips() {
  useSettings.getState().set({ beginnerTips: false });
  endGuide();
  toast('info', 'Tips are off. Settings → Beginner tips turns them back on.', undefined, 4000);
}

export function startGuide(id: string, steps: GuideStep[], onEnd?: () => void) {
  if (!steps.length) return;
  markTipSeen(id);
  useGuide.setState({ id, steps, index: 0, onEnd });
}

export function endGuide() {
  const g = useGuide.getState();
  useGuide.setState({ id: null, steps: [], index: 0, onEnd: undefined });
  g.onEnd?.();
}

export function guideRunning(id?: string): boolean {
  const cur = useGuide.getState().id;
  return id ? cur === id : !!cur;
}

/** A hint shown once, the first time something happens (when tips are on). */
export function hintOnce(id: string, text: string, ms = 6000) {
  if (!tipsOn() || tipSeen('hint.' + id)) return;
  markTipSeen('hint.' + id);
  toast('info', text, undefined, ms);
}

/** "a `code` b" → text with <code> */
function inline(s: string, key: number) {
  const parts = s.split('`');
  return <Fragment key={key}>{parts.map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</Fragment>;
}

/** paragraphs, "- " lists and `code` */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((para, i) => {
        const lines = para.split('\n');
        if (lines.every((l) => l.trim().startsWith('- '))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.trim().slice(2), j)}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => (j ? <Fragment key={j}><br />{inline(l, j)}</Fragment> : inline(l, j)))}</p>;
      })}
    </>
  );
}

const GAP = 10;

/** The callout of the running guide; mounted once at the app root. */
export function GuideLayer() {
  const { id, steps, index } = useGuide();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [size, setSize] = useState({ w: 300, h: 140 });
  const [done, setDone] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const step = id ? steps[index] : undefined;

  // what the step does when it shows
  useEffect(() => {
    setDone(false);
    if (!step?.enter) return;
    try {
      step.enter();
    } catch {
      /* a missing file or section: the text still stands */
    }
  }, [step]);

  // follow the target (it may move, appear late or scroll) and watch the task
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    let last = '#';
    let tick = 0;
    const loop = () => {
      const el = step.target ? (document.querySelector(step.target) as HTMLElement | null) : null;
      const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
      const key = r ? `${r.x},${r.y},${r.width},${r.height}` : '';
      if (key !== last) {
        last = key;
        setRect(r);
      }
      if (step.task && ++tick % 10 === 0) {
        try {
          if (step.task.done()) setDone(true);
        } catch {
          /* not yet */
        }
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useLayoutEffect(() => {
    if (card.current && (card.current.offsetWidth !== size.w || card.current.offsetHeight !== size.h)) setSize({ w: card.current.offsetWidth, h: card.current.offsetHeight });
  });

  if (!step) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const { w: W, h } = size;
  let left: number, top: number, arrow: 'up' | 'down' | 'left' | 'right' | null = null;
  if (rect && rect.height > vh * 0.4) {
    // a whole panel: beside it, near its top
    top = Math.min(Math.max(8, rect.top + 40), vh - h - 8);
    if (rect.right + GAP + W < vw - 8) {
      left = rect.right + GAP;
      arrow = 'left';
    } else if (rect.left - GAP - W > 8) {
      left = rect.left - GAP - W;
      arrow = 'right';
    } else {
      left = Math.min(Math.max(8, rect.left + rect.width / 2 - W / 2), vw - W - 8);
    }
  } else if (rect) {
    left = Math.min(Math.max(8, rect.left + rect.width / 2 - W / 2), vw - W - 8);
    if (rect.bottom + GAP + h < vh - 8) {
      top = rect.bottom + GAP;
      arrow = 'up';
    } else if (rect.top - GAP - h > 8) {
      top = rect.top - GAP - h;
      arrow = 'down';
    } else {
      top = Math.max(8, rect.top + 12);
    }
  } else {
    left = vw / 2 - W / 2;
    top = vh - h - 48;
  }
  const arrowStyle = !rect || !arrow ? {} : arrow === 'up' || arrow === 'down'
    ? { left: Math.min(Math.max(14, rect.left + rect.width / 2 - left), W - 14) }
    : { top: 22 };
  const last = index === steps.length - 1;
  const go = (d: number) => useGuide.setState({ index: index + d });
  const waiting = !!step.task && !done;
  return (
    <>
      {rect && <div className="guide-ring" style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }} />}
      <div ref={card} className={'guide-card' + (step.wide ? ' wide' : '')} style={{ left, top }} role="dialog" aria-label={step.title} onPointerDown={(e) => e.stopPropagation()}>
        {arrow && <i className={'guide-arrow ' + arrow} style={arrowStyle} />}
        {step.chapter && <div className="guide-chapter">{step.chapter}</div>}
        <div className="guide-head">
          <b>{step.title}</b>
          <span className="faint small-text">{index + 1} / {steps.length}</span>
          <button className="icon-btn small" onClick={endGuide} aria-label="Close the guide"><X size={13} /></button>
        </div>
        <div className="guide-text"><Rich text={step.text} /></div>
        {step.task && (
          <div className={'guide-task' + (done ? ' done' : '')}>
            {done ? <Check size={13} /> : <span className="guide-dot" />}
            <span>{step.task.text}</span>
          </div>
        )}
        <div className="guide-foot">
          <button className="rl-btn faint" onClick={stopAllTips}>Stop tips</button>
          <div className="grow" />
          {index > 0 && !step.choices && <button className="btn small ghost" onClick={() => go(-1)}>Back</button>}
          {step.choices
            ? step.choices.map((c) => <button key={c.label} className={'btn small' + (c.primary ? ' primary' : ' ghost')} onClick={() => {
              useGuide.setState({ id: null, steps: [], index: 0, onEnd: undefined });
              c.run();
            }}>{c.label}</button>)
            : <button className={'btn small' + (waiting ? ' ghost' : ' primary')} onClick={() => (last ? endGuide() : go(1))}>{waiting ? 'Skip' : last ? 'Done' : 'Next'}</button>}
        </div>
      </div>
    </>
  );
}
