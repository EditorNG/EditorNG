/**
 * Shared context menu: one host rendered by the app, opened from anywhere with openMenu().
 * Items show their shortcut, can be disabled with a reason (tooltip), and can open submenus.
 * Keyboard: ↑/↓ move, → / Enter open a submenu or run, ← closes a submenu, Esc closes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ChevronRight, Check } from 'lucide-react';

export interface MenuAction {
  label: string;
  /** shortcut shown on the right */
  key?: string;
  run?: () => void;
  /** true, or a reason shown as tooltip */
  disabled?: boolean | string;
  submenu?: MenuEntry[];
  checked?: boolean;
  danger?: boolean;
  /** secondary text (e.g. a count) */
  hint?: string;
}
export type MenuEntry = MenuAction | 'sep' | { title: string } | null | false | undefined | '';

interface MenuState {
  menu: null | { x: number; y: number; items: MenuEntry[] };
}
const useMenu = create<MenuState>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuEntry[]) {
  const clean = tidy(items);
  if (!clean.length) return;
  useMenu.setState({ menu: { x, y, items: clean } });
}
export function closeMenu() {
  useMenu.setState({ menu: null });
}

/** Drops falsy entries, leading/trailing/double separators. */
function tidy(items: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1] === 'sep') out.pop();
  return out;
}

const isAction = (e: MenuEntry): e is MenuAction => !!e && typeof e === 'object' && 'label' in e;

export function MenuHost() {
  const menu = useMenu((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.('.cmenu')) closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [menu]);
  if (!menu) return null;
  return <MenuList x={menu.x} y={menu.y} items={menu.items} root />;
}

function MenuList(props: { x: number; y: number; items: MenuEntry[]; root?: boolean; onBack?: () => void; flipX?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<null | { idx: number; x: number; y: number; left: number }>(null);
  const items = props.items;

  // keep inside the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let x = props.x, y = props.y;
    if (x + r.width > window.innerWidth - 4) x = props.flipX !== undefined ? Math.max(4, props.flipX - r.width + 2) : Math.max(4, window.innerWidth - r.width - 4);
    if (y + r.height > window.innerHeight - 4) y = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x, y });
  }, [props.x, props.y]);

  useEffect(() => {
    if (sub) return;
    const onKey = (e: KeyboardEvent) => {
      const acts = items.map((it, i) => (isAction(it) && !it.disabled ? i : -1)).filter((i) => i >= 0);
      if (!acts.length) return;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape') {
        stop();
        if (props.onBack) props.onBack();
        else closeMenu();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        const k = acts.indexOf(active);
        const n = e.key === 'ArrowDown' ? acts[(k + 1) % acts.length] : acts[(k - 1 + acts.length) % acts.length];
        setActive(n);
      } else if (e.key === 'ArrowLeft' && props.onBack) {
        stop();
        props.onBack();
      } else if ((e.key === 'ArrowRight' || e.key === 'Enter') && active >= 0) {
        stop();
        trigger(active);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const trigger = (i: number) => {
    const it = items[i];
    if (!isAction(it) || it.disabled) return;
    if (it.submenu) {
      const el = ref.current?.querySelectorAll('.cmenu-item')[i] as HTMLElement | undefined;
      const r = el?.getBoundingClientRect();
      setSub({ idx: i, x: (r?.right ?? pos.x + 200) - 2, y: (r?.top ?? pos.y) - 4, left: r?.left ?? pos.x });
      return;
    }
    closeMenu();
    it.run?.();
  };

  return (
    <>
      <div ref={ref} className="cmenu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} role="menu">
        {items.map((it, i) => {
          if (it === 'sep') return <div key={i} className="cmenu-sep" />;
          if (!it) return null;
          if (!isAction(it)) return <div key={i} className="cmenu-title">{(it as { title: string }).title}</div>;
          const reason = typeof it.disabled === 'string' ? it.disabled : undefined;
          return (
            <div
              key={i}
              className={'cmenu-item' + (i === active ? ' active' : '') + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '')}
              role="menuitem"
              aria-disabled={!!it.disabled}
              data-tip={reason}
              data-tip-pos="right"
              onPointerEnter={(e) => {
                setActive(i);
                if (it.submenu && !it.disabled) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setSub({ idx: i, x: r.right - 2, y: r.top - 4, left: r.left });
                } else if (sub && sub.idx !== i) setSub(null);
              }}
              onClick={() => trigger(i)}
            >
              <span className="cmenu-check">{it.checked ? <Check size={12} /> : null}</span>
              <span className="cmenu-label">{it.label}</span>
              {it.hint && <span className="cmenu-hint">{it.hint}</span>}
              {it.key && <span className="kbd">{it.key}</span>}
              {it.submenu && <ChevronRight size={12} className="cmenu-arrow" />}
            </div>
          );
        })}
      </div>
      {sub && isAction(items[sub.idx]) && (
        <MenuList x={sub.x} y={sub.y} flipX={sub.left} items={tidy((items[sub.idx] as MenuAction).submenu!)} onBack={() => setSub(null)} />
      )}
    </>
  );
}
