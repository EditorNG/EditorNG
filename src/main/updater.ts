/**
 * Self-update for the portable Windows build.
 *
 *   check     GitHub releases newer than this version (EDITORNG_UPDATE_FEED overrides the URL, for tests)
 *   download  the release zip into <userData>/updates, verified (size + GitHub's SHA-256), then unpacked
 *             next to it and checked (EditorNG.exe + resources/app.asar)
 *   install   a hidden PowerShell script waits for EditorNG to exit, backs the install folder up, copies
 *             the new files over it (retrying locked files), restores the backup if anything fails, and
 *             starts EditorNG again with --updated-from=<old> or --update-failed=<reason>
 *
 * Files are written with original-fs: Electron's fs treats *.asar as folders.
 */
import { app } from 'electron';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import yauzl from 'yauzl';
import { newerReleases, type ReleaseInfo } from '../core/update';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ofs: typeof import('fs') = require('original-fs');

const FEED = 'https://api.github.com/repos/EditorNG/EditorNG/releases?per_page=30';
const HEADERS = { 'User-Agent': 'EditorNG-updater', Accept: 'application/vnd.github+json' };

export interface UpdateCheck {
  status: 'none' | 'available' | 'error';
  current: string;
  releases: ReleaseInfo[];
  error?: string;
  /** false: offer the download page instead (why in `reason`) */
  canInstall: boolean;
  reason?: string;
}

export interface UpdateProgress {
  phase: 'download' | 'verify' | 'extract' | 'ready';
  received: number;
  total: number;
}

const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const installDir = () => path.dirname(process.execPath);
const exePath = () => process.execPath;

/** Why this copy cannot replace itself, or null when it can. */
function installBlocker(): string | null {
  if (!app.isPackaged) return 'This is a development build: run the new version from the release page.';
  if (process.platform !== 'win32') return 'Automatic updates are available on Windows only.';
  const dir = installDir();
  try {
    const probe = path.join(dir, `.editorng-write-test-${process.pid}`);
    ofs.writeFileSync(probe, 'ok');
    ofs.rmSync(probe, { force: true });
  } catch {
    return `EditorNG is in a protected folder (${dir}). Move the EditorNG folder somewhere like Documents to get automatic updates, or download the new version by hand.`;
  }
  return null;
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  const current = app.getVersion();
  const blocker = installBlocker();
  const base = { current, releases: [] as ReleaseInfo[], canInstall: !blocker, reason: blocker ?? undefined };
  try {
    const res = await fetch(process.env.EDITORNG_UPDATE_FEED || FEED, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 429) return { ...base, status: 'error', error: 'GitHub is limiting requests right now. Try again in an hour.' };
    if (!res.ok) return { ...base, status: 'error', error: `GitHub answered ${res.status}.` };
    const releases = newerReleases(await res.json(), current);
    if (!releases.length) return { ...base, status: 'none' };
    if (!releases[0].asset) return { ...base, releases, status: 'available', canInstall: false, reason: 'This release has no Windows zip attached yet. Try again later, or download it from the release page.' };
    return { ...base, releases, status: 'available' };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? 'GitHub did not answer in time.' : 'No connection to GitHub.';
    return { ...base, status: 'error', error: msg };
  }
}

// ------------------------------------------------------------------------------------------
// download + unpack
// ------------------------------------------------------------------------------------------

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    ofs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve()).on('error', reject);
  });
  return h.digest('hex');
}

function verifyDigest(digest: string | undefined, actual: string): boolean {
  if (!digest) return true;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  return !m || m[1].toLowerCase() === actual;
}

function extractZip(zipFile: string, dest: string, onEntry: (n: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let n = 0;
      const total = zip.entryCount;
      const root = path.resolve(dest) + path.sep;
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        const out = path.resolve(dest, name);
        // never write outside the staging folder ("zip slip")
        if (!(out + (name.endsWith('/') ? path.sep : '')).startsWith(root)) return reject(new Error(`unsafe path in zip: ${name}`));
        onEntry(++n, total);
        if (name.endsWith('/')) {
          ofs.mkdirSync(out, { recursive: true });
          return zip.readEntry();
        }
        ofs.mkdirSync(path.dirname(out), { recursive: true });
        zip.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) return reject(e2 ?? new Error('cannot read ' + name));
          const ws = ofs.createWriteStream(out);
          rs.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
      zip.readEntry();
    });
  });
}

let downloading: Promise<string> | null = null;

/** Downloads, verifies and unpacks a release; resolves to the staging folder. */
export function downloadUpdate(rel: ReleaseInfo, onProgress: (p: UpdateProgress) => void): Promise<string> {
  if (downloading) return downloading;
  downloading = (async () => {
    const a = rel.asset;
    if (!a) throw new Error('This release has no Windows zip.');
    const dir = updatesDir();
    ofs.mkdirSync(dir, { recursive: true });
    // leftovers of older updates
    for (const f of ofs.readdirSync(dir)) {
      if (f === 'update.log' || f.startsWith(rel.version)) continue;
      ofs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
    const zip = path.join(dir, `${rel.version}.zip`);
    const have = ofs.existsSync(zip) && ofs.statSync(zip).size === a.size && verifyDigest(a.digest, await sha256(zip));
    if (!have) {
      const part = zip + '.part';
      const res = await fetch(a.url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
      const total = a.size || Number(res.headers.get('content-length')) || 0;
      const ws = ofs.createWriteStream(part);
      let received = 0, last = 0;
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
          const now = Date.now();
          if (now - last > 120) {
            last = now;
            onProgress({ phase: 'download', received, total });
          }
        }
      } finally {
        await new Promise((r) => ws.end(r));
      }
      onProgress({ phase: 'verify', received, total });
      if (a.size && received !== a.size) throw new Error(`The download is incomplete (${received} of ${a.size} bytes). Try again.`);
      if (!verifyDigest(a.digest, await sha256(part))) throw new Error('The download is damaged (checksum mismatch). Try again.');
      ofs.renameSync(part, zip);
    }
    const stage = path.join(dir, rel.version);
    ofs.rmSync(stage, { recursive: true, force: true });
    await extractZip(zip, stage, (n, total) => onProgress({ phase: 'extract', received: n, total }));
    // the zip may hold the app at its root or inside one folder
    let appRoot = stage;
    if (!ofs.existsSync(path.join(stage, 'EditorNG.exe'))) {
      const sub = ofs.readdirSync(stage).map((f) => path.join(stage, f)).find((p) => ofs.existsSync(path.join(p, 'EditorNG.exe')));
      if (sub) appRoot = sub;
    }
    if (!ofs.existsSync(path.join(appRoot, 'EditorNG.exe')) || !ofs.existsSync(path.join(appRoot, 'resources', 'app.asar'))) throw new Error('The downloaded zip is not an EditorNG build.');
    onProgress({ phase: 'ready', received: 1, total: 1 });
    return appRoot;
  })();
  downloading.catch(() => {}).finally(() => (downloading = null));
  return downloading;
}

// ------------------------------------------------------------------------------------------
// install
// ------------------------------------------------------------------------------------------

/** Other EditorNG processes started from the same exe (they would lock the files). */
export function otherInstances(): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(0);
    const ps = `Get-CimInstance Win32_Process -Filter "Name='EditorNG.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve(0);
      try {
        let list = JSON.parse(out || '[]');
        if (!Array.isArray(list)) list = [list];
        const me = exePath().toLowerCase();
        // Electron's own helper processes (GPU, renderer…) are children of the main process: count main processes only
        const ours = list.filter((p: any) => String(p.ExecutablePath ?? '').toLowerCase() === me);
        const pids = new Set(ours.map((p: any) => p.ProcessId));
        const mains = ours.filter((p: any) => !pids.has(p.ParentProcessId));
        resolve(mains.filter((p: any) => p.ProcessId !== process.pid).length);
      } catch {
        resolve(0);
      }
    });
  });
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * EditorNG's own EDITORNG_* variables (test profile, headless window…) for the relaunched app: the
 * script starts with the user's default environment, not ours. Empty for normal use.
 */
function passEnv(): string {
  return Object.entries(process.env)
    .filter(([k, v]) => /^EDITORNG_/.test(k) && v !== undefined)
    .map(([k, v]) => `$env:${k} = ${q(v!)}`)
    .join('\n');
}

/** The updater script (Windows PowerShell 5.1 compatible). */
export function updateScript(o: { pid: number; install: string; staged: string; backup: string; log: string; from: string; to: string; cleanup: string[] }): string {
  return `$ErrorActionPreference = 'Continue'
$install = ${q(o.install)}
$staged = ${q(o.staged)}
$backup = ${q(o.backup)}
$log = ${q(o.log)}
$exe = Join-Path $install 'EditorNG.exe'
$rc = '/R:6', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XJ'
function Log($m) { Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format s) + '] ' + $m) -Encoding UTF8 }
function Launch($arg) { Start-Process -FilePath $exe -ArgumentList $arg -WorkingDirectory $install }
function Fail($arg) {
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $log) 'whats-new.json') -Force -ErrorAction SilentlyContinue
  Launch $arg
  exit 1
}
${passEnv()}
Log 'update ${o.from} -> ${o.to}: waiting for EditorNG to close'
Wait-Process -Id ${o.pid} -Timeout 60 -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Process -Name EditorNG -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (Get-Process -Name EditorNG -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { Log 'another EditorNG is still running: not updated'; Fail '--update-failed=busy' }
Start-Sleep -Milliseconds 500
Log 'backing up'
if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
& robocopy $install $backup /E @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Log ('backup failed: robocopy ' + $LASTEXITCODE); Fail '--update-failed=backup' }
Log 'copying the new version'
& robocopy $staged $install /E /IS /IT @rc | Out-Null
$ok = $LASTEXITCODE -lt 8
if ($ok) {
  # folders that belong to the app: drop files the new version no longer has
  foreach ($d in 'resources', 'locales') {
    if (Test-Path -LiteralPath (Join-Path $staged $d)) { & robocopy (Join-Path $staged $d) (Join-Path $install $d) /MIR @rc | Out-Null; if ($LASTEXITCODE -ge 8) { $ok = $false } }
  }
}
if (-not $ok -or -not (Test-Path -LiteralPath $exe)) {
  Log ('copy failed (robocopy ' + $LASTEXITCODE + '): restoring the previous version')
  & robocopy $backup $install /E /IS /IT @rc | Out-Null
  Log ('restore: robocopy ' + $LASTEXITCODE)
  Fail '--update-failed=copy'
}
Log 'done: starting the new version'
Launch '--updated-from=${o.from}'
Start-Sleep -Seconds 3
foreach ($p in @(${o.cleanup.map(q).join(', ')})) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
Log 'cleaned up'
`;
}

/** Starts the updater script; the caller quits the app right after. */
export function startInstall(staged: string, rel: ReleaseInfo, notes: unknown): void {
  const dir = updatesDir();
  const blocker = installBlocker();
  if (blocker) throw new Error(blocker);
  const script = path.join(dir, 'apply-update.ps1');
  const body = updateScript({
    pid: process.pid,
    install: installDir(),
    staged,
    backup: path.join(dir, 'backup'),
    log: path.join(dir, 'update.log'),
    from: app.getVersion(),
    to: rel.version,
    cleanup: [path.join(dir, rel.version), path.join(dir, `${rel.version}.zip`)],
  });
  // UTF-8 with BOM: Windows PowerShell reads it as UTF-8 (paths with accents)
  ofs.writeFileSync(script, '﻿' + body, 'utf8');
  // what the new version shows after the restart
  ofs.writeFileSync(path.join(dir, 'whats-new.json'), JSON.stringify(notes));
  // Start the script through WMI: it then has no parent link to EditorNG, so nothing that ends EditorNG
  // and its child processes (process-tree kills, job objects) can take the updater down with it.
  // It runs in a headless console (conhost --headless): PowerShell, robocopy and the relaunched EditorNG
  // get a console with no window at all, so nothing shows up and there is no window to close (closing a
  // console window would end every program attached to it, the new EditorNG included). Started hidden
  // too, so even a terminal that ignores the headless flag shows nothing.
  const cmd = `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const ps =
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ` +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(cmd)}; ProcessStartupInformation = $si }; exit [int]$r.ReturnValue`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000, stdio: 'ignore' });
  } catch {
    // WMI unavailable: start it directly (detached)
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
  }
}

/** Release notes saved before the restart (read once by the new version). */
export function takeWhatsNew(): unknown {
  const f = path.join(updatesDir(), 'whats-new.json');
  try {
    const j = JSON.parse(ofs.readFileSync(f, 'utf8'));
    ofs.rmSync(f, { force: true });
    return j;
  } catch {
    return null;
  }
}

/** Last lines of the updater log (shown when an update failed). */
export function updateLogTail(): string {
  try {
    return ofs.readFileSync(path.join(updatesDir(), 'update.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  } catch {
    return '';
  }
}
