import { useEffect, useMemo, useRef, useState } from 'react';
import { useUi, openTab } from '../state/ui';
import { ws } from '../project/workspace';
import { COMMANDS, command, commandKey } from './commands';
import { emptySel, setSel } from '../state/selection';
import { getViewport } from '../scene/ViewportPanel';
import { revealRange } from '../editor/CodeEditor';

interface Item {
  id: string;
  label: string;
  detail?: string;
  key?: string;
  run: () => void;
}

/** Subsequence fuzzy score: higher is better, -1 = no match. */
export function fuzzy(q: string, s: string): number {
  if (!q) return 0;
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  const idx = sl.indexOf(ql);
  if (idx >= 0) return 1000 - idx * 2 - (sl.length - ql.length) * 0.1;
  let score = 0, j = 0, streak = 0;
  for (let i = 0; i < sl.length && j < ql.length; i++) {
    if (sl[i] === ql[j]) {
      j++;
      streak++;
      score += 5 + streak * 2;
    } else streak = 0;
  }
  return j === ql.length ? score : -1;
}

export function Palette() {
  const mode = useUi((x) => x.palette);
  const [q, setQ] = useState('');
  const [sel, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setQ('');
    setSelIdx(0);
  }, [mode]);

  const items = useMemo<Item[]>(() => {
    if (!mode) return [];
    if (mode === 'commands') {
      return COMMANDS.filter((c) => !c.enabled || c.enabled()).map((c) => ({ id: c.id, label: `${c.group}: ${c.title}`, key: commandKey(c), run: () => command(c.id) }));
    }
    if (mode === 'files') {
      return [...ws.docs.values()]
        .filter((d) => !d.isCommon && d.lang !== 'text')
        .map((d) => ({ id: d.key, label: d.name, detail: d.vpath, run: () => openTab(d.key) }));
    }
    const v = ws.vehicle;
    if (!v) return [];
    return v.nodes.map((n, i) => ({
      id: n.name,
      label: n.name,
      detail: `${n.row.part.def.name} · ${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)}`,
      run: () => {
        const s = emptySel();
        s.nodes.add(n.name);
        setSel(s, { kind: 'node', idx: i });
        getViewport()?.frameNodes([i]);
        revealRange(n.row.src.file, n.row.src.node.s, n.row.src.node.e);
      },
    }));
  }, [mode]);

  const filtered = useMemo(() => {
    const scored = items.map((it) => ({ it, s: Math.max(fuzzy(q, it.label), fuzzy(q, it.detail ?? '') - 200) })).filter((x) => x.s >= 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map((x) => x.it);
  }, [items, q]);

  useEffect(() => {
    listRef.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!mode) return null;
  const close = () => useUi.setState({ palette: null });
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const placeholder = mode === 'commands' ? 'Type a command' : mode === 'files' ? 'Go to file' : 'Go to node';
  return (
    <div className="overlay" onPointerDown={close}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="input palette-input"
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSelIdx(0);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelIdx(Math.min(filtered.length - 1, sel + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelIdx(Math.max(0, sel - 1));
            } else if (e.key === 'Enter') run(filtered[sel]);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.map((it, i) => (
            <button key={it.id} className={'pal-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSelIdx(i)} onClick={() => run(it)}>
              <span className="ellipsis">{it.label}</span>
              {it.detail && <span className="faint ellipsis pal-detail">{it.detail}</span>}
              {it.key && <span className="kbd">{it.key}</span>}
            </button>
          ))}
          {!filtered.length && <div className="empty-hint">No matches</div>}
        </div>
      </div>
    </div>
  );
}
