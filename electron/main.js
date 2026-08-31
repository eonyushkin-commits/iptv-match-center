'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const sync = require('./sync');
const playlist = require('./playlist');
const vlc = require('./vlc');
const fotmob = require('./fotmob');
const favorites = require('./favorites');
const { autoUpdater } = require('electron-updater');

let win = null;
let channelsCache = null;

const GUIDE_WIDTH = 440;

function config() {
  const raw = store.readJson(paths.configPath, {});
  return { ...raw, playlistPath: paths.resolvePlaylist(raw.playlistPath) };
}

function saveConfig(patch) {
  const raw = store.readJson(paths.configPath, {});
  store.writeJson(paths.configPath, { ...raw, ...patch });
  channelsCache = null;
}

async function channels() {
  if (!channelsCache) {
    const p = config().playlistPath;
    channelsCache = p ? (await playlist.load(p)).channels : [];
  }
  return channelsCache;
}

/** VLC gets whatever screen space is left beside the app window, on
 * whichever display the app window currently sits on. Computed fresh each
 * time `vlc:play` is called, not tracked continuously — VLC is placed once
 * on first launch and is the user's own independent window after that (see
 * electron/vlc.js). */
function vlcTargetBounds() {
  if (!win) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const scale = display.scaleFactor;
  const wa = display.workArea;
  const appRight = b.x + b.width;
  return {
    x: appRight * scale,
    y: wa.y * scale,
    width: Math.max(0, wa.x + wa.width - appRight) * scale,
    height: wa.height * scale,
  };
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: GUIDE_WIDTH,
    height: wa.height,
    minWidth: 340,
    maxWidth: 700,
    backgroundColor: '#0e131a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(paths.ROOT, 'renderer', 'index.html'));
  win.on('closed', () => vlc.stop());
}

// Checked once per launch, same cadence as the full guide sync — not worth
// polling more often for a desktop app the user starts and stops by hand.
// GitHub Releases is a public feed now (repo made public specifically for
// this), so no token lives in the shipped app; `checkForUpdatesAndNotify()`
// itself is skipped in dev (`app.isPackaged` false) since there's no
// packaged version to compare against and it would just log noise every run.
function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => {
    // Network hiccup or no releases yet — quietly retry next launch, same
    // as a failed guide sync doesn't block the app either.
    console.error('update check failed:', err.message);
  });
}

autoUpdater.on('update-downloaded', (info) => {
  win?.webContents.send('update:ready', { version: info.version });
});

app.whenReady().then(() => {
  paths.ensureConfig();
  store.setRoot(paths.cacheDir);
  createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  vlc.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => vlc.stop());

/** Сетка с диска. Кэш от версии до 1.4 хранил дерево `days -> tournaments ->
 * events`; читать его нечем, а мигрировать незачем — полный синк идёт при
 * каждом запуске и всё равно перезапишет файл, так что старую форму проще
 * считать отсутствующей. */
function cachedGuide() {
  const guide = store.readJson(path.join(store.root, 'guide.json'), null);
  return Array.isArray(guide?.events) ? guide : null;
}

ipcMain.handle('guide:cached', () => cachedGuide());

ipcMain.handle('playlist:status', async () => {
  const p = config().playlistPath;
  if (!p) return { path: null, exists: false, count: 0 };
  try {
    return { path: p, exists: true, count: (await channels()).length };
  } catch (err) {
    return { path: p, exists: false, count: 0, error: err.message };
  }
});

/** Just the file picker — returns the chosen path without saving it. The
 * "Настройки" dialog collects playlist + EPG together and saves both at
 * once via `settings:save`. */
ipcMain.handle('playlist:choose', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите файл плейлиста',
    filters: [{ name: 'Плейлист', extensions: ['m3u', 'm3u8'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('settings:get', () => {
  const raw = store.readJson(paths.configPath, {});
  return {
    playlistPath: raw.playlistPath || '',
    epgUrl: raw.epgUrl || '',
    vlcPath: raw.vlcPath || '',
    competitions: fotmob.COMPETITIONS,
    disabledCompetitions: raw.disabledCompetitions || [],
  };
});

ipcMain.handle('settings:save', async (_e, { playlistPath, epgUrl, vlcPath, disabledCompetitions }) => {
  const p = (playlistPath || '').trim();
  if (!p) return { ok: false, error: 'Укажите файл или ссылку на плейлист' };
  const vp = (vlcPath || '').trim();
  if (vp && !fs.existsSync(vp)) return { ok: false, error: `Файл не найден: ${vp}` };

  // Сначала проверяем, что плейлист вообще читается, и только потом пишем
  // конфиг. Порядок был обратный: битая ссылка затирала прежний рабочий
  // путь — пользователь видел ошибку, но откатываться было уже некуда, а
  // при следующем запуске приложение вставало с нерабочим источником.
  let loaded;
  try {
    loaded = await playlist.load(paths.resolvePlaylist(p));
  } catch (err) {
    return { ok: false, error: err.message };
  }

  saveConfig({
    playlistPath: p,
    epgUrl: (epgUrl || '').trim() || undefined,
    vlcPath: vp || undefined,
    disabledCompetitions: Array.isArray(disabledCompetitions) && disabledCompetitions.length ? disabledCompetitions : undefined,
  });
  channelsCache = loaded.channels; // уже загружено — не перечитывать следом
  return { ok: true, count: loaded.channels.length };
});

/** Mirrors playlist:choose — a plain file picker, no side effects. The
 * "Настройки" dialog collects it together with playlist/EPG and saves all
 * three at once via settings:save. */
ipcMain.handle('vlc:choose', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите vlc.exe',
    filters: [{ name: 'VLC', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('guide:sync', async () => {
  const cfg = config();
  if (!cfg.playlistPath) {
    return { ok: false, error: 'Плейлист не выбран. Нажмите «Настройки» и укажите файл или ссылку' };
  }
  if (!playlist.isUrl(cfg.playlistPath) && !fs.existsSync(cfg.playlistPath)) {
    return { ok: false, error: 'Файл плейлиста не найден. Нажмите «Настройки» и проверьте путь' };
  }
  const send = (text, done, total) => win?.webContents.send('sync:progress', { text, done, total });
  try {
    return { ok: true, guide: await sync.run(cfg, send) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/** The lightweight companion to `guide:sync` — see sync.js → refreshScores.
 * Reads whatever's already on disk (kept in step with what the renderer
 * has, since both paths write through the same guide.json) rather than
 * holding a separate copy in main. No-ops quietly if nothing's been synced
 * yet — there's nothing to refresh before the first full sync. */
ipcMain.handle('guide:refreshScores', async () => {
  const guide = cachedGuide();
  if (!guide) return { ok: true, guide: null };
  try {
    return { ok: true, guide: await sync.refreshScores(guide) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('favorites:get', () => favorites.load());
ipcMain.handle('favorites:toggle', (_e, id) => favorites.toggle(id));

// Only ever called after 'update:ready' fired, so the download already
// finished — this just quits and swaps the installed files, no further
// network involved.
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

ipcMain.handle('vlc:play', async (_e, { url }) => {
  const vlcPath = vlc.findVlcPath(config().vlcPath);
  if (!vlcPath) {
    return { ok: false, error: 'VLC не найден. Установите VLC или укажите путь в «Настройки»' };
  }
  try {
    await vlc.play(vlcPath, url, vlcTargetBounds(), config().streamUserAgent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
