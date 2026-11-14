/**
 * The update window: what a new version brings (headline features first, with their titles
 * waving, then the smaller improvements and fixes), and one button that downloads, installs and
 * restarts. Shown again after the restart as "what's new".
 */
import { useEffect, useMemo } from 'react';
import { X, Sparkles, Download, ExternalLink, RotateCcw } from 'lucide-react';
import { useUpdate, installUpdate, skipVersion, checkForUpdates } from '../state/update';
import { useWs } from '../project/workspace';
import { useSettings } from '../state/settings';
import { combinedChangelog } from '@core/update';
import { api } from '../lib/api';

/** **bold**, `code` and [links](url) of release notes. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        if (/^\*\*.+\*\*$/.test(p)) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (/^`.+`$/.test(p)) return <code key={i}>{p.slice(1, -1)}</code>;
        const l = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
        if (l) return <a key={i} href={l[2]} onClick={(e) => { e.preventDefault(); api.openExternal(l[2]); }}>{l[1]}</a>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** megabytes as GitHub shows them (1 MB = 10^6 bytes) */
const mb = (b: number) => (b / 1e6).toFixed(b >= 100e6 ? 0 : 1);

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString();
}

export function UpdateDialog() {
  const view = useUpdate((x) => x.view);
  const check = useUpdate((x) => x.check);
  const whatsNew = useUpdate((x) => x.whatsNew);
  const phase = useUpdate((x) => x.phase);
  const received = useUpdate((x) => x.received);
  const total = useUpdate((x) => x.total);
  const speed = useUpdate((x) => x.speed);
  const error = useUpdate((x) => x.error);
  const dirty = useWs((x) => x.dirtyCount);
  const releases = view === 'whatsNew' ? whatsNew?.releases ?? [] : check?.releases ?? [];
  const log = useMemo(() => combinedChangelog(releases), [releases]);
  const busy = phase === 'download' || phase === 'verify' || phase === 'extract' || phase === 'installing';
  const close = () => !busy && useUpdate.setState({ view: null, phase: phase === 'error' ? 'idle' : phase });
  useEffect(() => {
    if (!view) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [view, busy]);
  if (!view || !releases.length) return null;
  const latest = releases[0];
  const from = view === 'whatsNew' ? whatsNew!.from : check!.current;
  const multi = releases.length > 1;
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  const pageUrl = latest.url || 'https://github.com/EditorNG/EditorNG/releases/latest';

  let footer: React.ReactNode;
  if (view === 'whatsNew') {
    footer = <><div className="grow" /><button className="btn primary" onClick={close}>Let's go</button></>;
  } else if (busy) {
    const label = phase === 'download' ? `Downloading ${mb(received)} / ${mb(total)} MB${speed > 0 ? ` · ${mb(speed)} MB/s` : ''}` : phase === 'verify' ? 'Checking the download…' : phase === 'extract' ? 'Unpacking…' : 'Installing: EditorNG restarts in a moment…';
    footer = (
      <div className="upd-progress">
        <div className="upd-bar"><div style={{ width: `${phase === 'download' ? pct : 100}%` }} className={phase === 'download' ? '' : 'indeterminate'} /></div>
        <span className="dim">{label}</span>
      </div>
    );
  } else if (!check!.canInstall) {
    footer = (
      <>
        <span className="upd-reason">{check!.reason}</span>
        <div className="grow" />
        <button className="btn" onClick={close}>Later</button>
        <button className="btn primary" onClick={() => api.openExternal(pageUrl)}><ExternalLink size={13} /> Download page</button>
      </>
    );
  } else {
    footer = (
      <>
        <button className="btn ghost" onClick={() => skipVersion(latest.version)} data-tip="Don't offer this version again (Help → Check for updates still shows it)" data-tip-pos="top">Skip this version</button>
        <div className="grow" />
        {phase === 'error' && <span className="upd-error">{error}</span>}
        <button className="btn" onClick={close}>Later</button>
        {phase === 'error' && <button className="btn" onClick={() => api.openExternal(pageUrl)}><ExternalLink size={13} /> Download page</button>}
        <button className="btn primary" onClick={() => installUpdate(dirty > 0)} data-tip={dirty > 0 ? `Saves your ${dirty} unsaved file${dirty > 1 ? 's' : ''} first` : undefined} data-tip-pos="top">
          {phase === 'error' ? <RotateCcw size={13} /> : <Download size={13} />} {phase === 'error' ? 'Try again' : dirty > 0 ? 'Save all, update and restart' : 'Update and restart'}
        </button>
      </>
    );
  }

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="modal upd" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={view === 'whatsNew' ? `What's new in EditorNG ${latest.version}` : `EditorNG ${latest.version} is available`}>
        <div className="upd-hero">
          <div className="upd-kicker"><Sparkles size={13} /> {view === 'whatsNew' ? 'Updated' : 'Update available'}</div>
          <div className="upd-version">EditorNG {latest.version}</div>
          <div className="upd-sub dim">
            {view === 'whatsNew' ? `You were on ${from}` : `You have ${from}`}
            {multi ? ` · ${releases.length} new releases` : latest.date ? ` · released ${ago(latest.date)}` : ''}
            {view === 'offer' && latest.asset ? ` · ${mb(latest.asset.size)} MB download` : ''}
          </div>
          {!busy && <button className="icon-btn small upd-close" onClick={close} aria-label="Close"><X size={14} /></button>}
        </div>
        <div className="upd-body">
          {log.features.length > 0 && (
            <div className="upd-features">
              {log.features.map((f, i) => (
                <div key={i} className="upd-feature">
                  <div className="upd-feature-head">
                    <span className="upd-new">New</span>
                    {multi && <span className="upd-ver mono">{f.version}</span>}
                  </div>
                  {f.title && <h3 className="upd-title">{f.title}</h3>}
                  {f.text && <p><Inline text={f.text} /></p>}
                </div>
              ))}
            </div>
          )}
          {log.improvements.length > 0 && (
            <div className="upd-minor">
              <h4>Improvements</h4>
              <ul>{log.improvements.map((x, i) => <li key={i}><Inline text={x.text} />{multi && <span className="upd-ver mono">{x.version}</span>}</li>)}</ul>
            </div>
          )}
          {log.fixes.length > 0 && (
            <div className="upd-minor fixes">
              <h4>Fixes</h4>
              <ul>{log.fixes.map((x, i) => <li key={i}><Inline text={x.text} />{multi && <span className="upd-ver mono">{x.version}</span>}</li>)}</ul>
            </div>
          )}
          {!log.features.length && !log.improvements.length && !log.fixes.length && (
            <div className="dim">No release notes. <a href={pageUrl} onClick={(e) => { e.preventDefault(); api.openExternal(pageUrl); }}>See the release page</a>.</div>
          )}
          <a className="upd-page small-text" href={pageUrl} onClick={(e) => { e.preventDefault(); api.openExternal(pageUrl); }}>Release page on GitHub <ExternalLink size={11} /></a>
        </div>
        <div className="modal-foot upd-foot">{footer}</div>
      </div>
    </div>
  );
}

/** Status bar: a new version is waiting (the window was closed with "Later"). */
export function UpdatePill() {
  const check = useUpdate((x) => x.check);
  const view = useUpdate((x) => x.view);
  const skip = useSettings((x) => x.s.updateSkip);
  if (check?.status !== 'available' || view) return null;
  const v = check.releases[0].version;
  if (v === skip) return null;
  return (
    <button className="status-item upd-pill" onClick={() => useUpdate.setState({ view: 'offer' })} data-tip="See what's new and update" data-tip-pos="top">
      <Sparkles size={12} /> Update {v}
    </button>
  );
}

export { checkForUpdates };
