/**
 * Link with the running game:
 *  - "Reload in game": saves, then asks the bridge mod to reload (or spawn) the vehicle.
 *  - the setup dialog that installs the bridge mod into the user's mods/unpacked folder.
 *  - the Game log tab: errors and warnings from <userDir>/beamng.log, filtered to the vehicle.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { RotateCw, AlertCircle, AlertTriangle, Trash2, FolderOpen } from 'lucide-react';
import { api } from '../lib/api';
import { ws, useWs } from '../project/workspace';
import { useUi, openTab } from '../state/ui';
import { toast } from '../state/toast';
import { settings } from '../state/settings';
import { revealRange } from '../editor/CodeEditor';
import { Modal } from './Dialogs';
import { openMenu } from './Menu';

// ------------------------------------------------------------------------------------------
// connection state
// ------------------------------------------------------------------------------------------

interface LinkState {
  /** null = unknown yet */
  connected: boolean | null;
  gameVehicle: string | null;
  busy: boolean;
}
export const useGameLink = create<LinkState>(() => ({ connected: null, gameVehicle: null, busy: false }));

async function ping(): Promise<boolean> {
  const r = await api.gameSend({ cmd: 'ping' }, 500).catch(() => null);
  useGameLink.setState({ connected: !!r?.ok, gameVehicle: r?.vehicle?.model ?? null });
  return !!r?.ok;
}

/** Saves everything, then reloads the vehicle in the running game (or spawns this one). */
export async function reloadInGame() {
  const model = ws.model;
  if (!model) {
    toast('info', 'Open a vehicle first');
    return;
  }
  useGameLink.setState({ busy: true });
  try {
    if (useWs.getState().dirtyCount > 0) await ws.saveAll();
    const r = await api.gameSend({ cmd: 'ping' }, 600).catch(() => null);
    const cfg = useWs.getState().activeConfig;
    const pc = cfg ? ws.doc(cfg)?.vpath : undefined;
    if (!r?.ok) {
      useGameLink.setState({ connected: false });
      await startGame(model, pc);
      return;
    }
    const same = r.vehicle?.model?.toLowerCase() === model.toLowerCase();
    const res = same ? await api.gameSend({ cmd: 'reload' }, 1500) : await api.gameSend({ cmd: 'spawn', model, config: pc ?? '' }, 1500);
    if (res?.ok) toast('info', same ? `Reloaded ${model} in game` : `Spawned ${model}${pc ? ' (' + pc.split('/').pop() + ')' : ''} in game`);
    else toast('warn', res?.error ? `Game: ${res.error}` : 'The game did not answer');
    useGameLink.setState({ connected: !!res, gameVehicle: same ? model : model });
  } finally {
    useGameLink.setState({ busy: false });
  }
}

/** Stock levels for Settings → "Start the game on" (folder name → menu label). */
export const GAME_LEVELS: Array<[string, string]> = [
  ['smallgrid', 'Grid, Small, Pure'],
  ['gridmap_v2', 'Grid Map'],
  ['automation_test_track', 'Automation Test Track'],
  ['west_coast_usa', 'West Coast, USA'],
  ['east_coast_usa', 'East Coast, USA'],
  ['italy', 'Italy'],
  ['Utah', 'Utah, USA'],
  ['Industrial', 'Industrial Site'],
  ['johnson_valley', 'Johnson Valley'],
  ['small_island', 'Small Island, USA'],
  ['hirochi_raceway', 'Hirochi Raceway'],
  ['jungle_rock_island', 'Jungle Rock Island'],
  ['derby', 'Derby Arenas'],
  ['driver_training', 'Driver Training'],
  ['Cliff', 'Cliff'],
  ['showroom_v2', 'Showroom'],
  ['', 'Main menu (no level)'],
];

let launchedAt = 0;

/**
 * The game is not answering. Running without the bridge: open the setup. Not running: install the
 * bridge if needed and start BeamNG on the chosen level with this vehicle (and config).
 */
async function startGame(model: string, pc: string | undefined) {
  if (await api.gameRunning()) {
    if (Date.now() - launchedAt < 4 * 60_000) {
      toast('info', 'BeamNG is still starting. Reload again once the level is loaded.', undefined, 4000);
      return;
    }
    // running, but the bridge mod is missing or not loaded
    useUi.setState({ dialog: { kind: 'gameLink' } });
    return;
  }
  const st = await api.gameBridgeStatus().catch(() => null);
  if (st && !st.installed && st.dir) {
    try {
      await api.gameBridgeInstall();
      toast('info', 'Installed the EditorNG bridge mod (lets Reload in game talk to BeamNG).', undefined, 5000);
    } catch {
      /* the game still starts; reloads will ask for the setup */
    }
  }
  const level = settings().gameStartLevel;
  const label = GAME_LEVELS.find(([k]) => k === level)?.[1] ?? level;
  try {
    await api.gameLaunch({ level, model, config: pc });
  } catch (e: any) {
    toast('error', `Could not start BeamNG: ${e?.message ?? e}`, { label: 'Settings', run: () => useUi.setState({ page: 'settings' }) });
    return;
  }
  launchedAt = Date.now();
  toast('info', `Starting BeamNG${level ? ` on ${label}` : ''} with ${model}${pc ? ` (${pc.split('/').pop()!.replace(/\.pc$/i, '')})` : ''}…`, undefined, 6000);
  // the link light turns green as soon as the bridge answers
  const t0 = Date.now();
  const poll = setInterval(async () => {
    if ((await ping()) || Date.now() - t0 > 5 * 60_000) clearInterval(poll);
  }, 4000);
}

export function ReloadInGameButton() {
  const model = useWs((x) => x.model);
  const { connected, busy, gameVehicle } = useGameLink();
  useEffect(() => {
    ping();
    const t = setInterval(() => document.hasFocus() && ping(), 8000);
    return () => clearInterval(t);
  }, []);
  const tip = connected
    ? `Save all and reload in the game (F5)${gameVehicle ? `\nGame vehicle: ${gameVehicle}` : ''}${gameVehicle && model && gameVehicle.toLowerCase() !== model.toLowerCase() ? `\n${model} will be spawned instead` : ''}`
    : 'Save all and reload the vehicle in BeamNG (F5)\nBeamNG is not running: starts it with this vehicle';
  return (
    <button className={'btn small title-btn primary' + (busy ? ' busy' : '')} disabled={!model || busy} data-tip={tip} data-tip-pos="bottom-left" onClick={() => reloadInGame()}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Reload in game', key: 'F5', disabled: model ? false : 'No vehicle open', run: () => reloadInGame() },
          { label: 'Set up game link…', run: () => useUi.setState({ dialog: { kind: 'gameLink' } }) },
        ]);
      }}>
      <span className={'link-dot' + (connected ? ' on' : '')} />
      <RotateCw size={13} className={busy ? 'spin' : ''} /> Reload in game
    </button>
  );
}

// ------------------------------------------------------------------------------------------
// setup dialog
// ------------------------------------------------------------------------------------------

export function GameLinkDialog({ close }: { close: () => void }) {
  const [status, setStatus] = useState<null | { installed: boolean; dir: string | null; files: string[] }>(null);
  const [busy, setBusy] = useState(false);
  const connected = useGameLink((x) => x.connected);
  useEffect(() => {
    api.gameBridgeStatus().then(setStatus);
    ping();
    const t = setInterval(ping, 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <Modal title="Reload in game" onClose={close} width={560} footer={<>
      <button className="btn" onClick={close}>Close</button>
      {status && !status.installed && (
        <button className="btn primary" disabled={busy || !status.dir} onClick={async () => {
          setBusy(true);
          try {
            await api.gameBridgeInstall();
            setStatus(await api.gameBridgeStatus());
            toast('info', 'Bridge mod installed. Restart BeamNG (or press Ctrl+L in game) to load it.');
          } catch (e: any) {
            toast('error', String(e?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}>Install the bridge mod</button>
      )}
    </>}>
      <div className="col" style={{ gap: 10 }}>
        <div>
          EditorNG talks to the running game through a tiny mod, <span className="mono">editorng_bridge</span>. It only listens on
          this computer (127.0.0.1, UDP port 46791) and can do three things: answer a ping, reload the current vehicle
          (like Ctrl+R) and spawn a vehicle with a configuration.
        </div>
        <div className="link-status">
          <span className={'link-dot' + (connected ? ' on' : '')} />
          {connected ? 'Connected to the game' : status?.installed ? 'Installed, but the game is not answering: start BeamNG, or press Ctrl+L in game after installing.' : 'Not installed yet.'}
        </div>
        {status && (
          <div>
            <div className="dim small-text" style={{ marginBottom: 4 }}>{status.installed ? 'Installed files' : 'Files that will be written'}:</div>
            <div className="sym-list mono">
              {status.files.map((f) => <div key={f}>{status.dir ? status.dir.replace(/\\/g, '/') + '/' : ''}{f}</div>)}
            </div>
            {!status.dir && <div className="warn-text small-text" style={{ marginTop: 6 }}>BeamNG user folder not found: set it in Settings → Paths.</div>}
            {status.installed && status.dir && (
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => api.reveal(status.dir!)}><FolderOpen size={12} /> Show folder</button>
            )}
          </div>
        )}
        <div className="faint small-text">To remove it, delete the editorng_bridge folder from mods/unpacked.</div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------
// game log
// ------------------------------------------------------------------------------------------

export interface LogLine {
  t: string;
  sev: 'E' | 'W' | 'I' | 'D';
  src: string;
  msg: string;
}

interface LogState {
  lines: LogLine[];
  offset: number;
  path: string | null;
  /** lines before this index were cleared by the user */
  clearedAt: number;
}
const useGameLog = create<LogState>(() => ({ lines: [], offset: 0, path: null, clearedAt: 0 }));

const LINE_RE = /^\s*([\d.]+)\|([EWID])\|([^|]*)\|\s?(.*)$/;

async function pollLog() {
  const st = useGameLog.getState();
  const r = await api.gameLogRead(st.offset).catch(() => null);
  if (!r) return;
  if (!r.text && !r.reset && r.path === st.path) {
    if (r.size !== st.offset) useGameLog.setState({ offset: r.size });
    return;
  }
  const add: LogLine[] = [];
  for (const raw of r.text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (m) add.push({ t: m[1], sev: m[2] as LogLine['sev'], src: m[3], msg: m[4] });
    else if (raw.trim() && add.length) add[add.length - 1].msg += '\n' + raw; // continuation (stack traces)
  }
  const lines = r.reset ? add : [...st.lines, ...add];
  const cap = lines.length > 20000 ? lines.slice(-20000) : lines;
  useGameLog.setState({ lines: cap, offset: r.size, path: r.path, clearedAt: r.reset ? 0 : Math.max(0, st.clearedAt - (lines.length - cap.length)) });
}

/** vehicles/<model>/....jbeam or a part name in a message → where to jump */
function locate(msg: string): null | { file?: string; part?: string } {
  const f = /vehicles\/[\w\-./]+?\.(jbeam|pc|json)/i.exec(msg);
  const v = ws.vehicle;
  if (v) {
    for (const tok of msg.split(/[^\w\-]+/)) {
      if (tok.length > 3 && v.partsByName.has(tok)) return { part: tok, file: f?.[0] };
    }
  }
  return f ? { file: f[0] } : null;
}

function jump(loc: { file?: string; part?: string }) {
  if (loc.part) {
    const p = ws.vehicle?.partsByName.get(loc.part);
    if (p) {
      revealRange(p.def.file, p.def.key.s, p.def.key.e, true);
      return;
    }
  }
  if (loc.file) {
    const d = [...ws.docs.values()].find((x) => x.vpath.toLowerCase() === loc.file!.toLowerCase().replace(/^\//, ''));
    if (d) openTab(d.key);
    else toast('info', `${loc.file} is not part of the open vehicle`);
  }
}

export function GameLogTab() {
  const { lines, path, clearedAt } = useGameLog();
  const model = useWs((x) => x.model);
  const v = useWs((x) => x.vehicle);
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [onlyVehicle, setOnlyVehicle] = useState(true);
  useEffect(() => {
    pollLog();
    const t = setInterval(pollLog, 1500);
    return () => clearInterval(t);
  }, []);
  const shown = useMemo(() => {
    const parts = v ? new Set(v.parts.map((p) => p.def.name.toLowerCase())) : new Set<string>();
    const m = model?.toLowerCase();
    const mentions = (l: LogLine) => {
      const text = (l.src + ' ' + l.msg).toLowerCase();
      if (m && (text.includes('vehicles/' + m + '/') || text.includes(m))) return true;
      for (const tok of text.split(/[^\w\-]+/)) if (tok.length > 3 && parts.has(tok)) return true;
      return false;
    };
    return lines
      .slice(clearedAt)
      .filter((l) => (!onlyProblems || l.sev === 'E' || l.sev === 'W') && (!onlyVehicle || !model || mentions(l)))
      .slice(-1500);
  }, [lines, clearedAt, onlyProblems, onlyVehicle, model, v]);
  const errs = shown.filter((l) => l.sev === 'E').length;
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="bpanel-tools">
        <label className="row dim"><button className={'switch' + (onlyProblems ? ' on' : '')} onClick={() => setOnlyProblems(!onlyProblems)} aria-label="Errors and warnings only" /> errors &amp; warnings only</label>
        <label className="row dim"><button className={'switch' + (onlyVehicle ? ' on' : '')} onClick={() => setOnlyVehicle(!onlyVehicle)} aria-label="This vehicle only" /> {model ? `mentioning ${model}` : 'this vehicle'}</label>
        <span className="faint">{shown.length} shown{errs ? ` · ${errs} errors` : ''}</span>
        <div className="grow" />
        <button className="btn small ghost" onClick={() => useGameLog.setState({ clearedAt: useGameLog.getState().lines.length })}><Trash2 size={12} /> Clear</button>
        {path && <button className="btn small ghost" onClick={() => api.reveal(path)} data-tip={path} data-tip-pos="top-left"><FolderOpen size={12} /> beamng.log</button>}
      </div>
      <div className="list-scroll">
        {shown.map((l, k) => {
          const loc = locate(l.msg);
          return (
            <button key={k} className="problem log-line" onClick={() => loc && jump(loc)} title={l.msg} onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, [
                loc && { label: loc.part ? `Go to part ${loc.part}` : `Open ${loc.file}`, run: () => jump(loc) },
                { label: 'Copy line', run: () => navigator.clipboard.writeText(`${l.t}|${l.sev}|${l.src}| ${l.msg}`) },
              ]);
            }}>
              {l.sev === 'E' ? <AlertCircle size={13} className="err-text" /> : l.sev === 'W' ? <AlertTriangle size={13} className="warn-text" /> : <span style={{ width: 13 }} />}
              <span className="faint mono log-t">{l.t}</span>
              <span className="ellipsis grow">{l.msg.split('\n')[0]}</span>
              <span className="faint ellipsis small-text" style={{ maxWidth: 260 }}>{loc?.part ?? l.src}</span>
            </button>
          );
        })}
        {!shown.length && (
          <div className="empty-hint">
            {path ? 'Nothing yet. Errors and warnings the game logs while you test show up here.' : 'beamng.log not found: set the BeamNG user folder in Settings → Paths.'}
          </div>
        )}
      </div>
    </div>
  );
}
