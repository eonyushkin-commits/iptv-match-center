'use strict';
// Словарь имён команд как ДАННЫЕ, а не константы в коде. В предыдущем проекте
// такая таблица жила в исходнике, и любая правка сопоставления требовала
// правки кода и выпуска новой версии — при том что это чистые данные,
// меняющиеся по мере того, как вещатели придумывают новые написания.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../main/store');
const teams = require('../main/teams');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-teams-'));
store.setRoot(tmp);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  for (const f of ['teams.json', 'teams-candidates.json']) {
    try { fs.unlinkSync(path.join(tmp, f)); } catch { /* нет так нет */ }
  }
});

describe('formsFor', () => {
  test('полное имя, короткое и алиасы — всё вместе', () => {
    const forms = teams.formsFor({ 'Bayern München': ['Бавария'] }, 'Bayern München', 'Bayern');
    assert.deepStrictEqual(forms, ['Bayern München', 'Bayern', 'Бавария']);
  });

  test('дубликаты схлопываются', () => {
    assert.deepStrictEqual(teams.formsFor({}, 'Milan', 'Milan'), ['Milan']);
  });

  test('пустое короткое имя не попадает в формы', () => {
    assert.deepStrictEqual(teams.formsFor({}, 'Milan', ''), ['Milan']);
  });

  test('несколько алиасов на одну команду', () => {
    const forms = teams.formsFor({ X: ['А', 'Б'] }, 'X', null);
    assert.deepStrictEqual(forms, ['X', 'А', 'Б']);
  });
});

describe('load: файл поверх семян', () => {
  test('без файла отдаёт семена', () => {
    const aliases = teams.load();
    assert.deepStrictEqual(aliases['Bayern München'], ['Бавария']);
  });

  test('файл добавляет команду, которой в семенах нет', () => {
    store.writeJson(teams.filePath(), { v: 1, aliases: { 'Real Betis': ['Бетис'] } });
    const aliases = teams.load();
    assert.deepStrictEqual(aliases['Real Betis'], ['Бетис']);
    assert.deepStrictEqual(aliases['Bayern München'], ['Бавария'], 'семена остаются');
  });

  test('файл ПЕРЕКРЫВАЕТ семя — в этом и смысл: правка без релиза', () => {
    store.writeJson(teams.filePath(), { v: 1, aliases: { 'Bayern München': ['Бавария', 'Бавария Мюнхен'] } });
    assert.deepStrictEqual(teams.load()['Bayern München'], ['Бавария', 'Бавария Мюнхен']);
  });

  test('пустой список снимает семя, если оно оказалось вредным', () => {
    store.writeJson(teams.filePath(), { v: 1, aliases: { 'Bayern München': [] } });
    assert.deepStrictEqual(teams.load()['Bayern München'], []);
  });

  test('файл чужой версии игнорируется целиком, а не ломает запуск', () => {
    store.writeJson(teams.filePath(), { v: 99, aliases: { X: ['Ы'] } });
    const aliases = teams.load();
    assert.strictEqual(aliases.X, undefined);
    assert.deepStrictEqual(aliases['Bayern München'], ['Бавария']);
  });

  test('битый файл не роняет — просто семена', () => {
    fs.writeFileSync(teams.filePath(), '{ это не json');
    assert.deepStrictEqual(teams.load()['Bayern München'], ['Бавария']);
  });
});

describe('ensureFile', () => {
  test('заводит файл из семян при первом запуске', () => {
    teams.ensureFile();
    const saved = store.readJson(teams.filePath(), null);
    assert.ok(saved, 'файл должен появиться');
    assert.deepStrictEqual(saved.aliases['Bayern München'], ['Бавария']);
  });

  test('существующий файл не затирает', () => {
    store.writeJson(teams.filePath(), { v: 1, aliases: { Мой: ['Вариант'] } });
    teams.ensureFile();
    assert.deepStrictEqual(store.readJson(teams.filePath(), null).aliases, { Мой: ['Вариант'] });
  });
});

describe('кандидаты в словарь', () => {
  test('нечёткие попадания копятся отдельно и НЕ применяются сами', () => {
    teams.recordCandidates(new Map([['Juventus', new Set(['yuventus'])]]));
    const saved = store.readJson(teams.candidatesPath(), null);
    assert.deepStrictEqual(saved.candidates.Juventus, ['yuventus']);
    // Главное: на реальный словарь это не влияет.
    assert.strictEqual(teams.load().Juventus, undefined);
  });

  test('накапливаются между прогонами, без дублей', () => {
    teams.recordCandidates(new Map([['Juventus', new Set(['yuventus'])]]));
    teams.recordCandidates(new Map([['Juventus', new Set(['yuventus', 'juve'])]]));
    const saved = store.readJson(teams.candidatesPath(), null);
    assert.deepStrictEqual(saved.candidates.Juventus.sort(), ['juve', 'yuventus']);
  });

  test('пустой набор файла не трогает', () => {
    teams.recordCandidates(new Map());
    assert.strictEqual(store.readJson(teams.candidatesPath(), null), null);
  });
});
