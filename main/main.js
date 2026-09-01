'use strict';
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const paths = require('./paths');
const sync = require('./sync');
const playlist = require('./playlist');
const player = require('./player');
const fotmob = require('./fotmob');
const { autoUpdater } = require('electron-updater');

let win = null;
let channelsCache = null;
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

// Проверяется один раз за запуск — чаще для десктопа, который человек сам
// открывает и закрывает, смысла нет. В dev-режиме пропускается молча: сравнить
// не с чем, а в лог сыпались бы обращения к GitHub на каждый `npm start`.
// Репозиторий публичный именно ради того, чтобы это работало без токена
// внутри собранного приложения.
function checkForUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdates().catch((err) => {
    // Сеть моргнула или GitHub недоступен — тихо отложим до следующего
    // запуска, ровно как и с неудавшимся синком.
    console.error('проверка обновлений не удалась:', err.message);
  });
}

// Шлём в рендерер только когда файл уже скачан целиком: промежуточные
// состояния «ищу»/«качаю» — лишний шум, кнопка нужна одна.
autoUpdater.on('update-downloaded', (info) => {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('update:ready', { version: info.version });
  } catch { /* окна уже нет */ }
});

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

/**
 * Место для окна VLC — вся полоса экрана справа от окна приложения, на том
 * мониторе, где оно сейчас стоит. Считается заново на каждый `vlc:play`, а не
 * отслеживается постоянно: окно ставится один раз при запуске VLC, дальше оно
 * в полном распоряжении пользователя.
 *
 * `* scale` обязателен: Electron сообщает координаты в независимых от
 * плотности пикселях, а SetWindowPos ждёт физические. На мониторе со
 * стопроцентным масштабом разницы нет, и ошибку легко не заметить.
 */
function vlcTargetBounds() {
  if (!win || win.isDestroyed()) return null;
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

/** Сетка с диска. Чужую версию формата считаем отсутствием кэша: приложение
 * носит то же имя, что и 1.4.8, значит читает ту же папку в %APPDATA% и
 * наткнётся на его guide.json, где у трансляции нет ни `sources`, ни `epg`.
 * Мигрировать незачем — полный синк идёт при каждом запуске. */
function cachedGuide() {
  const guide = store.readJson(path.join(store.root, 'guide.json'), null);
  return guide?.v === sync.GUIDE_FORMAT && Array.isArray(guide.events) ? guide : null;
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

ipcMain.handle('guide:sync', async () => {
  const cfg = config();
  if (!cfg.playlistPath) {
    return { ok: false, error: 'Плейлист не выбран. Нажмите «Настройки» и укажите файл или ссылку' };
  }
  if (!playlist.isUrl(cfg.playlistPath) && !fs.existsSync(cfg.playlistPath)) {
    return { ok: false, error: 'Файл плейлиста не найден. Нажмите «Настройки» и проверьте путь' };
  }
  const send = (text) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('sync:progress', { text });
    } catch { /* окно закрыли посреди синка */ }
  };
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

/* ---------------- настройки ---------------- */

// Диалоги выбора файла — без побочных эффектов: просто возвращают путь.
// Сохранение всегда идёт одной точкой, через settings:save.
ipcMain.handle('playlist:choose', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите файл плейлиста',
    filters: [{ name: 'Плейлист', extensions: ['m3u', 'm3u8'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : (res.filePaths[0] || null);
});

ipcMain.handle('vlc:choose', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Выберите vlc.exe',
    filters: [{ name: 'VLC', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : (res.filePaths[0] || null);
});

ipcMain.handle('settings:get', () => {
  const raw = store.readJson(paths.configPath, {});
  return {
    playlistPath: raw.playlistPath || '',
    epgUrl: raw.epgUrl || '',
    vlcPath: raw.vlcPath || '',
    // Статика из fotmob.js — сетевой запрос за каталогом турниров тут не
    // нужен, чек-лист показывает только наш кураторский список.
    competitions: fotmob.COMPETITIONS,
    disabledCompetitions: raw.disabledCompetitions || [],
  };
});

ipcMain.handle('settings:save', async (_e, { playlistPath, epgUrl, vlcPath, disabledCompetitions }) => {
  const p = (playlistPath || '').trim();
  if (!p) return { ok: false, error: 'Укажите файл или ссылку на плейлист' };
  const vp = (vlcPath || '').trim();
  if (vp && !fs.existsSync(vp)) return { ok: false, error: `Файл не найден: ${vp}` };

  // Сперва проверяем, что плейлист вообще читается, и только потом пишем
  // конфиг. Обратный порядок означал бы, что битая ссылка затирает прежний
  // рабочий путь: пользователь видит ошибку, а откатываться уже некуда, и при
  // следующем запуске приложение встаёт с нерабочим источником.
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
    disabledCompetitions: Array.isArray(disabledCompetitions) && disabledCompetitions.length
      ? disabledCompetitions
      : undefined,
  });
  channelsCache = loaded.channels; // уже загружено — не перечитывать следом
  return { ok: true, count: loaded.channels.length };
});

/* ---------------- обновление и плеер ---------------- */

// Вызывается только после 'update:ready', то есть файл уже скачан: здесь
// остаётся выйти и подменить файлы, сети больше не нужно.
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

ipcMain.handle('vlc:play', async (_e, { url }) => {
  const vlcPath = player.findVlcPath(config().vlcPath);
  if (!vlcPath) {
    return { ok: false, error: 'VLC не найден. Установите VLC или укажите путь в «Настройках»' };
  }
  try {
    await vlc.play(vlcPath, url, { bounds: vlcTargetBounds(), userAgent: config().streamUserAgent });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
