'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// In a packaged build ROOT points inside app.asar, which is read-only. Config,
// cache and the playlist have to live somewhere writable instead:
//   %APPDATA%\iptv-match-center        Windows
//   ~/.config/iptv-match-center        Linux
//   ~/Library/Application Support/iptv-match-center   macOS
const dataDir = app.isPackaged ? app.getPath('userData') : ROOT;

// Tracked in git as a blank template — the live config.json (personal
// playlist/EPG paths) is gitignored and never itself committed.
const bundledConfig = path.join(ROOT, 'config.example.json');
const configPath = path.join(dataDir, 'config.json');

/** Seeds the writable config from the bundled defaults on first launch. */
function ensureConfig() {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(bundledConfig, configPath);
  }
  return configPath;
}

function resolvePlaylist(p) {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return path.isAbsolute(p) ? p : path.join(dataDir, p);
}

// НЕ `cache`. Chromium держит свой дисковый HTTP-кэш ровно в
// `userData/Cache`, а пути на Windows регистронезависимы — то есть
// `userData/cache` и `userData/Cache` это одна и та же папка. Наши
// guide.json, favorites.json и скачанный EPG оказывались внутри неё, рядом с
// `Cache_Data/data_0…data_3` и `index`, и Chromium вычищал их при своей
// уборке. Наружу это выглядело так: после перезапуска расписание «сбрасы­
// вается» (guide.json исчез, кэш считается отсутствующим), EPG качается
// заново каждый запуск вместо шести часов TTL, а избранное пропадает.
// В dev-режиме баг не воспроизводился: там наши файлы лежат в папке проекта,
// а кэш Chromium — в %APPDATA%, и они не пересекались.
const cacheDir = path.join(dataDir, 'data');

// Разовый перенос избранного из старого места. Расписание и EPG
// восстановятся сами при первом же синке, а список избранных матчей — нет,
// это единственное, что пользователь вводил руками.
function migrateFavorites() {
  const old = path.join(dataDir, 'cache', 'favorites.json');
  const now = path.join(cacheDir, 'favorites.json');
  try {
    if (fs.existsSync(old) && !fs.existsSync(now)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.copyFileSync(old, now);
    }
  } catch { /* нечего переносить или уже недоступно — не повод падать при старте */ }
}

module.exports = {
  ROOT,
  configPath,
  cacheDir,
  ensureConfig,
  migrateFavorites,
  resolvePlaylist,
};
