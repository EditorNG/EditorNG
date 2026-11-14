/** Update state shared by the update window, the status bar pill and the Help menu. */
import { create } from 'zustand';
import { api } from '../lib/api';
import { settings, useSettings } from './settings';
import { toast } from './toast';
import { useWs, ws } from '../project/workspace';
import type { ReleaseInfo } from '@core/update';

type Check = Awaited<ReturnType<typeof api.updateCheck>>;

export interface UpdateState {
  check: Check | null;
  /** the update window: offer (new version available) or whatsNew (after updating) */
  view: null | 'offer' | 'whatsNew';
  phase: 'idle' | 'checking' | 'download' | 'verify' | 'extract' | 'installing' | 'error';
  received: number;
  total: number;
  /** bytes per second, smoothed */
  speed: number;
  error: string;
  /** after an update: the version we came from and the releases installed */
  whatsNew: null | { from: string; releases: ReleaseInfo[] };
}

export const useUpdate = create<UpdateState>(() => ({ check: null, view: null, phase: 'idle', received: 0, total: 0, speed: 0, error: '', whatsNew: null }));

let lastTick = { t: 0, b: 0 };
api.onUpdateProgress?.((p) => {
  const now = performance.now();
  const st = useUpdate.getState();
  let speed = st.speed;
  if (p.phase === 'download' && lastTick.t && now > lastTick.t) {
    const inst = ((p.received - lastTick.b) / (now - lastTick.t)) * 1000;
    speed = speed ? speed * 0.7 + inst * 0.3 : inst;
  }
  lastTick = { t: now, b: p.received };
  if (p.phase !== 'ready') useUpdate.setState({ phase: p.phase, received: p.received, total: p.total, speed });
});

/** Asks GitHub for a newer version. Automatic checks stay silent unless one is found (and not skipped). */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (useUpdate.getState().phase !== 'idle' && useUpdate.getState().phase !== 'error') return;
  if (manual) useUpdate.setState({ phase: 'checking' });
  const check = await api.updateCheck().catch((e) => ({ status: 'error', error: String(e?.message ?? e), current: '', releases: [], canInstall: false }) as Check);
  useUpdate.setState({ check, phase: 'idle', error: '' });
  if (check.status === 'error') {
    if (manual) toast('warn', `Could not check for updates: ${check.error}`);
    return;
  }
  if (check.status === 'none') {
    if (manual) toast('ok', `EditorNG ${check.current} is the latest version`, undefined, 2500);
    return;
  }
  const latest = check.releases[0].version;
  if (!manual && settings().updateSkip === latest) return;
  useUpdate.setState({ view: 'offer' });
}

/** Saves if asked, downloads, verifies, unpacks, then hands over to the updater (the app quits). */
export async function installUpdate(saveFirst: boolean): Promise<void> {
  const st = useUpdate.getState();
  const rel = st.check?.releases[0];
  if (!rel) return;
  if (saveFirst) {
    await ws.saveAll();
    if (useWs.getState().dirtyCount > 0) {
      useUpdate.setState({ phase: 'error', error: 'Some files could not be saved. Save them by hand, then update.' });
      return;
    }
  }
  lastTick = { t: 0, b: 0 };
  useUpdate.setState({ phase: 'download', received: 0, total: rel.asset?.size ?? 0, speed: 0, error: '' });
  const dl = await api.updateDownload(rel.version);
  if (!dl.ok || !dl.staged) {
    useUpdate.setState({ phase: 'error', error: dl.error ?? 'Download failed.' });
    return;
  }
  useUpdate.setState({ phase: 'installing' });
  const notes = { from: st.check!.current, releases: st.check!.releases };
  const r = await api.updateInstall(rel.version, dl.staged, notes);
  if (!r.ok) useUpdate.setState({ phase: 'error', error: r.error ?? 'Could not start the update.' });
}

export function skipVersion(v: string) {
  useSettings.getState().set({ updateSkip: v });
  useUpdate.setState({ view: null });
}

/** At startup: what's new after an update, a failed update, then the automatic check. */
export async function updateOnBoot(env: { automation?: boolean; updatedFrom?: string; updateFailed?: string; updateLog?: string }) {
  if (env.updatedFrom) {
    const notes = (await api.updateWhatsNew().catch(() => null)) as UpdateState['whatsNew'];
    if (notes?.releases?.length) useUpdate.setState({ whatsNew: notes, view: 'whatsNew' });
    else toast('ok', `Updated from ${env.updatedFrom}`);
  }
  if (env.updateFailed) {
    const why = env.updateFailed === 'busy' ? 'another EditorNG window was still open' : env.updateFailed === 'backup' ? 'the current version could not be backed up' : 'some files could not be replaced (antivirus or another program using them)';
    toast('error', `The update did not install: ${why}. Nothing changed; you can try again.`, { label: 'Try again', run: () => checkForUpdates(true) });
  }
  if (!env.automation && settings().updateCheck) setTimeout(() => checkForUpdates(false), 6000);
}
