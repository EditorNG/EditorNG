/**
 * Brings the BeamNG.drive window to the front (restoring it when minimized) after "Reload in game".
 *
 * Windows only lets a program take the foreground for another one when it is (or was started by)
 * the program the user is using: EditorNG is, since the user just clicked Reload in game, and the
 * helper below is its child. The helper is one hidden PowerShell that stays up with the user32
 * calls compiled once, so a switch takes milliseconds instead of a PowerShell start each time.
 * When Windows still refuses, the game's taskbar button flashes instead.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const CS = `
using System;
using System.Runtime.InteropServices;
public static class EngWin {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);
  public static string Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    SetForegroundWindow(h);
    if (GetForegroundWindow() == h) return "ok";
    var f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f); f.hwnd = h; f.dwFlags = 3 | 12; f.uCount = 0; f.dwTimeout = 0;
    FlashWindowEx(ref f);
    return "flash";
  }
}`;

// reads "focus <ms>" lines; answers ok | flash | none (no game window within <ms>)
const PS = `
Add-Type -TypeDefinition @'
${CS}
'@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($null -eq $l) { break }
  $wait = 0; [int]::TryParse(($l -replace '[^0-9]', ''), [ref]$wait) | Out-Null
  $end = (Get-Date).AddMilliseconds($wait)
  $r = 'none'
  do {
    $p = Get-Process -Name 'BeamNG.drive.x64' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $r = [EngWin]::Focus($p.MainWindowHandle); break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $end)
  [Console]::Out.WriteLine($r); [Console]::Out.Flush()
}`;

let helper: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<boolean> | null = null;
let buffer = '';
const waiting: Array<(line: string) => void> = [];

function start(): Promise<boolean> {
  if (ready && helper && helper.exitCode === null) return ready;
  buffer = '';
  const encoded = Buffer.from(PS, 'utf16le').toString('base64');
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true });
  const h = helper;
  ready = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    h.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line === 'ready') {
          clearTimeout(t);
          resolve(true);
        } else if (line) waiting.shift()?.(line);
      }
    });
    h.on('exit', () => {
      clearTimeout(t);
      resolve(false);
      while (waiting.length) waiting.shift()!('none');
      if (helper === h) {
        helper = null;
        ready = null;
      }
    });
    h.on('error', () => resolve(false));
  });
  return ready;
}

/** Switches to the BeamNG window (waiting up to `waitMs` for it): ok | flash | none | unavailable. */
export async function focusGame(waitMs = 3000): Promise<string> {
  if (process.platform !== 'win32') return 'unavailable';
  if (!(await start()) || !helper) return 'unavailable';
  const h = helper;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('none'), waitMs + 5000);
    waiting.push((line) => {
      clearTimeout(t);
      resolve(line);
    });
    h.stdin.write(`focus ${Math.max(0, Math.round(waitMs))}\n`);
  });
}

/** Starts the helper ahead of time (so the first switch is quick too). */
export function warmUpGameFocus() {
  if (process.platform === 'win32') start().catch(() => {});
}

export function stopGameFocus() {
  try {
    helper?.stdin.end();
    helper?.kill();
  } catch {
    /* already gone */
  }
  helper = null;
  ready = null;
}
