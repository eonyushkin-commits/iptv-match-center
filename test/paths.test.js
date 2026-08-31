'use strict';
// Папка наших данных не должна совпадать с той, которую Chromium считает
// своей. Он держит дисковый HTTP-кэш в `userData/Cache`, а пути на Windows
// регистронезависимы — поэтому `userData/cache` это ТА ЖЕ папка, и Chromium
// вычищал оттуда guide.json, favorites.json и скачанный EPG при своей уборке.
// Снаружи это выглядело как «расписание сбросилось после перезапуска»,
// «EPG качается заново каждый запуск» и пропадающее избранное.
//
// Проверяется по исходнику, а не через require: paths.js тянет `electron`
// первой строкой и вне Electron не загружается. Зато и ловится ровно то, что
// нужно, — имя папки, выбранное в коде.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'electron', 'paths.js'), 'utf8');

// Каталоги, которые Chromium/Electron создают внутри userData сами.
// Совпадение с любым из них означает, что мы кладём данные в чужую папку.
const RESERVED = [
  'cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache',
  'network', 'local storage', 'session storage', 'shared dictionary',
  'blob_storage', 'databases', 'indexeddb', 'service worker', 'partitions',
];

describe('paths: папка данных не пересекается с кэшем Chromium', () => {
  const m = SRC.match(/const cacheDir = path\.join\(dataDir, '([^']+)'\)/);

  test('имя папки данных читается из исходника', () => {
    assert.ok(m, 'не найдено определение cacheDir — проверь, не переименовали ли его');
  });

  test('это не один из служебных каталогов Chromium', () => {
    const name = m[1].toLowerCase();
    assert.ok(
      !RESERVED.includes(name),
      `папка данных названа «${m[1]}», а её создаёт и чистит сам Chromium — он удалит наши файлы`,
    );
  });

  test('сравнение регистронезависимое — на Windows «cache» и «Cache» одно и то же', () => {
    for (const bad of ['cache', 'Cache', 'CACHE', 'GPUCache']) {
      assert.ok(RESERVED.includes(bad.toLowerCase()), `«${bad}» должно считаться занятым именем`);
    }
  });

  test('избранное переносится из старого места разово', () => {
    assert.match(SRC, /function migrateFavorites/);
    assert.match(SRC, /'cache', 'favorites\.json'/, 'перенос должен читать именно старый путь');
  });
});
