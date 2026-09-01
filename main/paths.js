'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// В упакованной сборке ROOT указывает внутрь app.asar — она только для
// чтения. Конфиг, кэш и индекс должны лежать там, где можно писать.
const dataDir = app.isPackaged ? app.getPath('userData') : ROOT;

const bundledConfig = path.join(ROOT, 'config.example.json');
const configPath = path.join(dataDir, 'config.json');

// НЕ `cache`. Chromium держит свой дисковый HTTP-кэш в `userData/Cache`, а
// пути на Windows регистронезависимы — то есть `userData/cache` и
// `userData/Cache` это одна и та же папка, и Chromium вычищает её при своей
// уборке вместе с нашими файлами. В предыдущем проекте это стоило пропавшего
// расписания и избранного после каждого перезапуска, причём воспроизводилось
// только на собранном приложении: в dev-режиме наши файлы лежат в папке
// проекта и с кэшем не пересекаются. Инвариант стережёт test/paths.test.js.
const dataRoot = path.join(dataDir, 'data');

/** Заводит конфиг из шаблона при первом запуске. */
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

module.exports = { ROOT, configPath, dataRoot, ensureConfig, resolvePlaylist };
