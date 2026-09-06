'use strict';
// Три места, где приложение раньше молчало или могло навредить себе.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../main/store');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
const STAGE = fs.readFileSync(path.join(__dirname, '..', 'main', 'epg-stage.js'), 'utf8');

describe('пустой разбор EPG не проходит молча', () => {
  test('этап предупреждает, когда в фиде нет ни одной передачи плейлиста', () => {
    const m = STAGE.match(/if \(!epgStats\.total\) \{[\s\S]{0,300}?\}/);
    assert.ok(m, 'нет проверки epgStats.total');
    assert.match(m[0], /onProgress/, 'о пустом разборе надо сказать, а не молчать');
  });

  test('проверка стоит сразу после получения индекса, до сопоставления', () => {
    const iGet = STAGE.indexOf('await epgIndex.get(');
    const iWarn = STAGE.indexOf('if (!epgStats.total)');
    const iMatch = STAGE.indexOf('link.fromEpg(');
    assert.ok(iGet < iWarn && iWarn < iMatch, 'предупредить надо раньше, чем впустую считать');
  });
});

describe('вторая копия приложения не поднимается', () => {
  // Обе копии пишут в одну папку в %APPDATA% — сетку, индекс, кэши. Их записи
  // затирали бы друг друга, и заметить это было бы нечем.
  test('замок одиночного экземпляра запрашивается', () => {
    assert.match(MAIN, /app\.requestSingleInstanceLock\(\)/);
  });

  test('без замка процесс выходит', () => {
    assert.match(MAIN, /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.quit\(\);/);
  });

  test('вместо второго окна показывается уже открытое', () => {
    const m = MAIN.match(/'second-instance'[\s\S]{0,300}?\}\);/);
    assert.ok(m, 'нет обработчика second-instance');
    assert.match(m[0], /win\.focus\(\)/);
  });
});

describe('атомарная запись не сталкивается между процессами', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-write-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('имя временного файла содержит номер процесса', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'store.js'), 'utf8');
    assert.match(src, /\$\{p\}\.\$\{process\.pid\}\.tmp/);
  });

  test('после записи временного файла не остаётся', () => {
    store.setRoot(tmp);
    const p = path.join(tmp, 'a.json');
    store.writeJson(p, { x: 1 });
    const left = fs.readdirSync(tmp).filter((n) => n.includes('.tmp'));
    assert.deepStrictEqual(left, [], `остался мусор: ${left}`);
    assert.deepStrictEqual(store.readJson(p, null), { x: 1 });
  });

  test('перезапись существующего файла работает', () => {
    store.setRoot(tmp);
    const p = path.join(tmp, 'b.json');
    store.writeJson(p, { v: 1 });
    store.writeJson(p, { v: 2 });
    assert.deepStrictEqual(store.readJson(p, null), { v: 2 });
  });
});
