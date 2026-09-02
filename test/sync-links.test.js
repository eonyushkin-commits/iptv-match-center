'use strict';
// Кэш связей, записанный прежними версиями, должен выбрасываться.
//
// В 2.0.0 связи переиспользовались без проверки версии фида и записывались
// обратно под версией НОВОГО фида — негодный кэш «отмывался». Проверка версий
// из 2.0.1 такой кэш отвергнуть не может: версии в нём совпадают честно.
// Единственное, что его отличает, — номер формата, под которым он записан.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'sync.js'), 'utf8');

describe('версия формата links.json', () => {
  test('больше единицы — иначе кэш от 2.0.0 будет принят за годный', () => {
    const m = SRC.match(/const LINKS_FORMAT = (\d+)/);
    assert.ok(m, 'не найдено определение LINKS_FORMAT');
    assert.ok(Number(m[1]) >= 2, `LINKS_FORMAT = ${m[1]}: кэш, отмытый версией 2.0.0, не будет отвергнут`);
  });

  test('чужая версия формата не доезжает до этапа', () => {
    assert.match(
      SRC,
      /cachedLinks: savedLinks\?\.v === LINKS_FORMAT \? savedLinks : null/,
      'sync.js должен отдавать этапу null, а не связи, если версия формата чужая',
    );
  });

  test('этапу отдаётся сохранённое ЦЕЛИКОМ, с версиями', () => {
    // Отдать одни лишь byFixture — значит отдать связи без срока годности.
    assert.ok(!/cachedLinks:.*byFixture/.test(SRC), 'связи без версий отдавать нельзя');
  });
});
