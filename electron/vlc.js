'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const koffi = require('koffi');

const CANDIDATE_PATHS = [
  'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
  'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
];

function findVlcPath(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  for (const p of CANDIDATE_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

// --- Win32: place VLC's own top-level window beside the app on first launch.
// VLC stays a normal, independent OS window from then on (own title bar,
// own controls, movable/resizable by the user) — we only touch it once to
// get it out from under the app window, not continuously.
const user32 = koffi.load('user32.dll');
const HWND = koffi.pointer('HWND', koffi.opaque());
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr lParam)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32 *lpdwProcessId)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(HWND hWnd)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)');

const SWP_FRAMECHANGED = 0x0020, SWP_SHOWWINDOW = 0x0040;
const SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, SW_RESTORE = 9;

function findWindowForPid(pid) {
  const found = [];
  const cb = koffi.register((hwnd) => {
    const pidBuf = [0];
    GetWindowThreadProcessId(hwnd, pidBuf);
    if (pidBuf[0] === pid && IsWindowVisible(hwnd)) found.push(hwnd);
    return true;
  }, koffi.pointer(EnumWindowsProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return found[0] || null;
}

/** A maximized window ignores SetWindowPos's size/position (Windows keeps
 * rendering it at the monitor's work-area rect regardless) until it's taken
 * out of the maximized state first — VLC starts (or ends up) maximized/
 * fullscreen here, which is what fights this placement. */
function place(hwnd, x, y, width, height) {
  ShowWindow(hwnd, SW_RESTORE);
  SetWindowPos(hwnd, null, Math.round(x), Math.round(y), Math.round(width), Math.round(height),
    SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}

let current = null; // { child, hwnd, httpPort, httpPassword }

function httpCommand(params) {
  return new Promise((resolve) => {
    if (!current) return resolve();
    const qs = new URLSearchParams(params).toString();
    const req = http.get({
      host: '127.0.0.1',
      port: current.httpPort,
      path: `/requests/status.xml?${qs}`,
      auth: `:${current.httpPassword}`,
      timeout: 3000,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve()); // best-effort — a failed switch just leaves the old channel playing
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

/**
 * Plays `url`. First call spawns VLC as its own independent window, placed
 * once beside the app at `bounds` (screen px) — after that the user owns
 * that window (move/resize/fullscreen freely). Later calls reuse the
 * running process (swap the URL over VLC's own HTTP control interface)
 * instead of recreating the window, and don't touch its position at all.
 */
async function play(vlcPath, url, bounds, userAgent) {
  if (current) {
    await httpCommand({ command: 'pl_empty' });
    await httpCommand({ command: 'in_play', input: url });
    return;
  }

  const httpPort = 39457;
  const httpPassword = crypto.randomBytes(12).toString('hex');
  const args = [
    url,
    '--no-video-title-show',
    '--no-qt-privacy-ask',
    '--no-qt-error-dialogs',
    '--no-play-and-exit',
    // Qt's default behaviour is to snap the window to the video's native
    // resolution the moment playback starts, overriding whatever size we
    // just set — this is what was fighting our initial placement.
    '--no-qt-video-autoresize',
    // Overrides a saved "start fullscreen" preference in the user's own
    // vlcrc — without this the window jumps to (0,0)-fullmonitor regardless
    // of our positioning, the moment playback actually starts.
    '--no-fullscreen',
    // Lets later channel switches reuse this same process/window instead of
    // killing and recreating it.
    '--extraintf=http', '--http-host=127.0.0.1', `--http-port=${httpPort}`, `--http-password=${httpPassword}`,
  ];
  // Some providers reject VLC's default UA on segment requests.
  if (userAgent) args.push(`--http-user-agent=${userAgent}`);
  const child = spawn(vlcPath, args, { stdio: 'ignore' });

  let hwnd = null;
  for (let i = 0; i < 40 && !hwnd; i++) {
    await new Promise((r) => setTimeout(r, 250));
    hwnd = findWindowForPid(child.pid);
  }
  if (!hwnd) {
    try { child.kill(); } catch { /* already gone */ }
    throw new Error('Не удалось найти окно VLC после запуска');
  }

  // Hide → place → show, so the window doesn't flash at VLC's default spot
  // before jumping to its real position.
  ShowWindow(hwnd, SW_HIDE);
  if (bounds) place(hwnd, bounds.x, bounds.y, bounds.width, bounds.height);
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);

  current = { child, hwnd, httpPort, httpPassword };
  child.on('exit', () => { if (current?.child === child) current = null; });

  // VLC can (re-)fullscreen itself shortly after the video track actually
  // starts rendering — a moment after window creation, not at it — so one
  // placement doesn't survive that. Keep re-asserting for a few seconds so
  // ours is the one that sticks once it settles. After that the window is
  // the user's to move/resize/fullscreen as they like.
  if (bounds) {
    for (const delay of [300, 700, 1200, 2000, 3500]) {
      setTimeout(() => {
        if (current?.hwnd !== hwnd) return;
        place(hwnd, bounds.x, bounds.y, bounds.width, bounds.height);
      }, delay);
    }
  }
}

function stop() {
  if (!current) return;
  try { current.child.kill(); } catch { /* already gone */ }
  current = null;
}

module.exports = { findVlcPath, play, stop };
