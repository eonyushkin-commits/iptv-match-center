'use strict';
// Папка наших данных не должна совпадать с той, которую Chromium считает
// своей. Он держит дисковый HTTP-кэш в `userData/Cache`, а пути на Windows
// регистронезависимы — поэтому `userData/cache` это ТА ЖЕ папка, и Chromium
// вычищает оттуда наши файлы при своей уборке. В предыдущем проекте это
// выглядело как «расписание сбросилось после перезапуска», «EPG качается
// заново каждый запуск» и пропадающее избранное, причём воспроизводилось
// только на собранном приложении: в dev-режиме файлы лежат в папке проекта.
//
// Проверяется по исходнику, а не через require: paths.js тянет `electron`
// первой строкой и вне Electron не загружается. Зато ловится ровно то, что
// нужно, — имя папки, выбранное в коде.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'paths.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'store.js'), 'utf8');

// Каталоги, которые Chromium/Electron создают внутри userData сами.
const RESERVED = [
  'cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache',
  'network', 'local storage', 'session storage', 'shared dictionary',
  'blob_storage', 'databases', 'indexeddb', 'service worker', 'partitions',
];

describe('папка данных не пересекается с кэшем Chromium', () => {
  const m = SRC.match(/const dataRoot = path\.join\(dataDir, '([^']+)'\)/);

  test('имя папки данных читается из исходника', () => {
    assert.ok(m, 'не найдено определение dataRoot — проверь, не переименовали ли его');
  });

  test('это не один из служебных каталогов Chromium', () => {
    assert.ok(
      !RESERVED.includes(m[1].toLowerCase()),
      `папка данных названа «${m[1]}», а её создаёт и чистит сам Chromium — он удалит наши файлы`,
    );
  });

  test('значение по умолчанию в store.js — тоже не занятое имя', () => {
    const d = STORE_SRC.match(/let root = path\.join\(__dirname, '\.\.', '([^']+)'\)/);
    assert.ok(d, 'не найдено значение root по умолчанию');
    assert.ok(!RESERVED.includes(d[1].toLowerCase()), `значение по умолчанию «${d[1]}» занято Chromium`);
  });

  test('сравнение регистронезависимое — на Windows «cache» и «Cache» одно и то же', () => {
    for (const bad of ['cache', 'Cache', 'CACHE', 'GPUCache']) {
      assert.ok(RESERVED.includes(bad.toLowerCase()), `«${bad}» должно считаться занятым именем`);
    }
  });
});
