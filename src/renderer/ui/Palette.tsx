/**
 * Quick open, VS Code style: the search box in the title bar opens this list right under it.
 * The first character picks what is searched: nothing = files, ">" commands, "@" nodes,
 * "#" parts, ":" a line of the open file, "%" text in every file, "?" the list of modes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useUi, openTab } from '../state/ui';
import { ws, useWs } from '../project/workspace';
import { COMMANDS, command, commandKey } from './commands';
import { emptySel, setSel } from '../state/selection';
import { getViewport } from '../scene/ViewportPanel';
import { revealRange } from '../editor/CodeEditor';
import { keyFor } from '../state/settings';
import { fileIconFor } from './fileIcons';

interface Item {
  id: string;
  label: string;
  detail?: string;
  key?: string;
  icon?: React.ReactNode;
  /** text shown greyed after the label (e.g. a mode prefix) */
  hint?: string;
  run: () => void;
  /** keep the list open (mode switch) */
  keep?: boolean;
  sep?: boolean;
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

const PREFIX: Record<string, string> = { commands: '>', nodes: '@', files: '', vehicles: '' };

/** Recently opened files, most recent first (this session). */
const recent: string[] = [];
useUi.subscribe((st, prev) => {
  if (!st.activeTab || st.activeTab === prev.activeTab) return;
  const i = recent.indexOf(st.activeTab);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(st.activeTab);
  if (recent.length > 30) recent.pop();
});

function relPath(vpath: string): string {
  const m = ws.model;
  const base = m ? `vehicles/${m}/` : '';
  const dir = vpath.slice(0, vpath.lastIndexOf('/'));
  return base && (dir + '/').toLowerCase().startsWith(base.toLowerCase()) ? dir.slice(base.length) || m! : dir;
}

function openFileItem(key: string): Item | null {
  const d = ws.doc(key);
  if (!d) return null;
  return { id: 'f:' + d.key, label: d.name, detail: relPath(d.vpath), icon: fileIconFor(d.name), run: () => openTab(d.key) };
}

export function Palette() {
  const mode = useUi((x) => x.palette);
  const vehicleList = useWs((x) => x.vehicles);
  const [q, setQ] = useState('');
  const [sel, setSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setQ(mode ? PREFIX[mode] ?? '' : '');
    setSelIdx(0);
  }, [mode]);

  const prefix = mode === 'vehicles' ? '' : /^[>@#:%?]/.test(q) ? q[0] : '';
  const term = (prefix ? q.slice(1) : q).trim();

  const items = useMemo<Item[]>(() => {
    if (!mode) return [];
    if (mode === 'vehicles') {
      return vehicleList.map((v) => {
        const mod = v.sources.find((x) => x.kind !== 'game');
        return { id: v.model, label: v.model, detail: mod ? mod.label : 'BeamNG', run: () => ws.openVehicle(v.model) };
      });
    }
    const switchTo = (p: string) => () => {
      setQ(p);
      setSelIdx(0);
      inputRef.current?.focus();
    };
    if (prefix === '?' || (!prefix && !term && q === '')) {
      const help: Item[] = [
        { id: 'h:file', label: 'Go to File', key: keyFor('app.quickOpen'), run: switchTo(''), keep: true },
        { id: 'h:cmd', label: 'Show and Run Commands', hint: '>', key: keyFor('app.palette'), run: switchTo('>'), keep: true },
        { id: 'h:node', label: 'Go to Node', hint: '@', key: keyFor('app.gotoNode'), run: switchTo('@'), keep: true },
        { id: 'h:part', label: 'Go to Part', hint: '#', run: switchTo('#'), keep: true },
        { id: 'h:line', label: 'Go to Line in Editor', hint: ':', run: switchTo(':'), keep: true },
        { id: 'h:text', label: 'Search for Text', hint: '%', run: switchTo('%'), keep: true },
        { id: 'h:veh', label: 'Open Vehicle', run: () => command('app.openVehicle') },
      ];
      if (prefix === '?') return help;
      const rec = recent.map(openFileItem).filter((x): x is Item => !!x).slice(0, 12);
      if (rec.length) rec[0] = { ...rec[0], sep: true, hint: 'recently opened' };
      return [...help, ...rec];
    }
    if (prefix === '>') {
      return COMMANDS.filter((c) => !c.enabled || c.enabled()).map((c) => ({ id: c.id, label: `${c.group}: ${c.title}`, key: commandKey(c), run: () => command(c.id) }));
    }
    const v = ws.vehicle;
    if (prefix === '@') {
      if (!v) return [];
      return v.nodes.map((n, i) => ({
        id: 'n:' + n.name,
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
    }
    if (prefix === '#') {
      const out: Item[] = [];
      for (const d of ws.docs.values()) {
        if (d.isCommon && !v?.parts.some((p) => p.def.file === d.key)) continue;
        for (const p of d.jfile?.parts ?? []) {
          out.push({
            id: 'p:' + d.key + '#' + p.name,
            label: p.name,
            detail: `${p.info.name ?? ''}${p.info.name ? ' · ' : ''}${d.name}`,
            icon: fileIconFor(d.name),
            run: () => {
              ws.focusPart(p.name);
              revealRange(d.key, p.key.s, p.key.e, true);
            },
          });
        }
      }
      return out;
    }
    if (prefix === ':') {
      const d = ws.doc(useUi.getState().activeTab);
      const line = parseInt(term, 10);
      if (!d || d.binary) return [{ id: 'l:none', label: 'Open a file first', run: () => {}, keep: true }];
      const lines = d.text.split('\n').length;
      if (!term || !Number.isFinite(line)) return [{ id: 'l:hint', label: `Type a line number between 1 and ${lines}`, detail: d.name, run: () => {}, keep: true }];
      const ln = Math.max(1, Math.min(lines, line));
      return [{
        id: 'l:' + ln,
        label: `Go to line ${ln}`,
        detail: d.name,
        run: () => {
          const m = ws.ensureModel(d);
          const s = m.getOffsetAt({ lineNumber: ln, column: 1 });
          revealRange(d.key, s, s, true);
        },
      }];
    }
    if (prefix === '%') {
      if (term.length < 2) return [{ id: 't:hint', label: 'Type at least 2 characters', run: () => {}, keep: true }];
      const out: Item[] = [];
      const tl = term.toLowerCase();
      for (const d of ws.docs.values()) {
        if (d.binary || d.isCommon) continue;
        const text = d.text;
        const low = text.toLowerCase();
        let at = low.indexOf(tl);
        while (at >= 0 && out.length < 300) {
          const ls = text.lastIndexOf('\n', at) + 1;
          let le = text.indexOf('\n', at);
          if (le < 0) le = text.length;
          const lineNo = text.slice(0, ls).split('\n').length;
          const pos = at;
          out.push({
            id: `t:${d.key}:${at}`,
            label: text.slice(ls, le).trim().slice(0, 160),
            detail: `${d.name}:${lineNo}`,
            icon: fileIconFor(d.name),
            run: () => revealRange(d.key, pos, pos + term.length, true),
          });
          at = low.indexOf(tl, le);
        }
      }
      return out;
    }
    // files
    return [...ws.docs.values()]
      .filter((d) => !d.isCommon || v?.parts.some((p) => p.def.file === d.key))
      .map((d) => ({ id: 'f:' + d.key, label: d.name, detail: relPath(d.vpath), icon: fileIconFor(d.name), run: () => openTab(d.key) }));
  }, [mode, vehicleList, prefix, prefix === ':' || prefix === '%' ? term : '', q === '']);

  const filtered = useMemo(() => {
    if (prefix === ':' || prefix === '%' || prefix === '?' || (!prefix && !term && mode !== 'vehicles')) return items.slice(0, 300);
    const scored = items.map((it) => ({ it, s: Math.max(fuzzy(term, it.label), fuzzy(term, it.detail ?? '') - 200) })).filter((x) => x.s >= 0);
    if (term) scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map((x) => x.it);
  }, [items, term, prefix, mode]);

  useEffect(() => {
    listRef.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!mode) return null;
  const close = () => useUi.setState({ palette: null });
  const run = (it: Item | undefined) => {
    if (!it) return;
    if (!it.keep) close();
    it.run();
  };
  const placeholder =
    mode === 'vehicles' ? 'Open a vehicle (mods listed first)'
      : prefix === '>' ? 'Type a command'
      : prefix === '@' ? 'Go to node by name'
      : prefix === '#' ? 'Go to part'
      : prefix === ':' ? 'Line number'
      : prefix === '%' ? 'Search text in all files'
      : 'Search files by name (append > for commands, @ nodes, # parts, : line, % text)';
  return (
    <div className="qo-overlay" onPointerDown={close}>
      <div className="palette qo" onPointerDown={(e) => e.stopPropagation()}>
        <div className="qo-input-wrap">
          <Search size={14} className="faint" />
          <input
            ref={inputRef}
            className="input palette-input"
            autoFocus
            placeholder={placeholder}
            value={q}
            spellCheck={false}
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
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.map((it, i) => (
            <div key={it.id}>
              {it.sep && <div className="pal-sep" />}
              <button className={'pal-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSelIdx(i)} onClick={() => run(it)}>
                {it.icon}
                <span className="ellipsis pal-label">{it.label}</span>
                {it.hint && !it.sep && <span className="pal-hint mono">{it.hint}</span>}
                {it.detail && <span className="faint ellipsis pal-detail">{it.detail}</span>}
                {it.sep && <span className="faint pal-detail">{it.hint}</span>}
                {it.key && <span className="kbd">{it.key}</span>}
              </button>
            </div>
          ))}
          {!filtered.length && <div className="empty-hint">No matches</div>}
        </div>
      </div>
    </div>
  );
}
