'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const sync = require('./sync');
const playlist = require('./playlist');
const player = require('./player');

let win = null;
const vlc = player.createPlayer();

const GUIDE_WIDTH = 440;

// Последний рубеж. По умолчанию Electron показывает необработанное исключение
// главного процесса модальным окном со стеком поверх приложения — для
// однопользовательского десктопа это худший исход: пугает, ничего не
// объясняет и не даёт продолжить.
//
// Осознанно НЕ выходим следом: канон «упавший процесс в неизвестном состоянии
// надо перезапускать» писан для серверов, где процесс безлик и поднимется
// сам. Здесь его падение — это исчезнувшее окно у человека, который смотрит
// матч, а всё важное уже на диске и пишется атомарно.
function reportInternal(kind, err) {
  console.error(`${kind}:`, err);
  // В try обязательно: у закрытого окна `send()` бросает «Object has been
  // destroyed», а бросок ИЗ обработчика необработанных исключений — это уже
  // ровно то окно с ошибкой, ради которого всё затевалось.
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sync:progress', { text: `Внутренняя ошибка: ${err?.message || err}` });
    }
  } catch { /* окна нет — остаётся только console выше */ }
}
process.on('uncaughtException', (err) => reportInternal('uncaught exception', err));
process.on('unhandledRejection', (reason) => reportInternal('unhandled rejection', reason));

function config() {
  const raw = store.readJson(paths.configPath, {});
  return { ...raw, playlistPath: paths.resolvePlaylist(raw.playlistPath) };
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: GUIDE_WIDTH,
    height: wa.height,
    minWidth: 360,
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

app.whenReady().then(() => {
  // Окно должно появиться при любом исходе подготовки. Без этого try падение
  // любой из двух строк ниже (нет места, права на %APPDATA%, шаблон конфига
  // не попал в сборку) оставляло бы приложение НЕВИДИМЫМ висящим процессом:
  // createWindow() не выполнился, а `window-all-closed` не срабатывает,
  // потому что окон и не создавали.
  try {
    paths.ensureConfig();
    store.setRoot(paths.dataRoot);
  } catch (err) {
    console.error('подготовка данных не удалась:', err.message);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  vlc.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => vlc.stop());

const cachedGuide = () => {
  const guide = store.readJson(path.join(store.root, 'guide.json'), null);
  return Array.isArray(guide?.events) ? guide : null;
};

ipcMain.handle('guide:cached', () => cachedGuide());

ipcMain.handle('playlist:status', async () => {
  const p = config().playlistPath;
  if (!p) return { path: null, exists: false, count: 0 };
  try {
    const { channels } = await playlist.load(p);
    return { path: p, exists: true, count: channels.length };
  } catch (err) {
    return { path: p, exists: false, count: 0, error: err.message };
  }
});

ipcMain.handle('guide:sync', async () => {
  const cfg = config();
  if (!cfg.playlistPath) return { ok: false, error: 'Плейлист не выбран — укажите его в config.json' };
  const send = (text) => win?.webContents.send('sync:progress', { text });
  try {
    return { ok: true, guide: await sync.run(cfg, send) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('guide:refreshScores', async () => {
  const guide = cachedGuide();
  if (!guide) return { ok: true, guide: null };
  try {
    return { ok: true, guide: await sync.refreshScores(guide) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('vlc:play', async (_e, { url }) => {
  const vlcPath = player.findVlcPath(config().vlcPath);
  if (!vlcPath) return { ok: false, error: 'VLC не найден. Установите VLC или задайте vlcPath в config.json' };
  try {
    await vlc.play(vlcPath, url, config().streamUserAgent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
