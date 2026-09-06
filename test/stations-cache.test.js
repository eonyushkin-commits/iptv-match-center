'use strict';
// Кэш заявок вещателей не должен запоминать провал.
//
// Ошибки по странам глушатся поодиночке — чтобы одна отвалившаяся не топила
// остальные. Из-за этого полный обрыв сети выглядит ровно как честный ответ
// «никто ничего не показывает»: `byCountry` пуст в обоих случаях. Такой
// результат ложился в кэш на три часа, и всё это время источник даже не
// спрашивали. Живой случай: сеть моргнула в 10:04, и до 13:04 в ленте не было
// ни одной заявки вещателей — 273 трансляции только из EPG и ни слова о том,
// что произошло.
//
// Отличить одно от другого можно только счётчиком ответивших стран, поэтому
// collectStations его и возвращает.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../main/store');
const broadcasters = require('../main/broadcasters');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stations-'));
store.setRoot(tmp);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'sync.js'), 'utf8');

describe('collectStations сообщает, сколько стран ответило', () => {
  test('форма результата — не голая карта', () => {
    // Голая карта не даёт отличить «сеть легла» от «никто не показывает».
    assert.match(SRC, /const \{ byCountry, asked, answered \} = await broadcasters\.collectStations/);
  });

  test('sync.js не пишет кэш, когда не ответил никто', () => {
    const guard = SRC.match(/if \(!answered\) \{[\s\S]{0,300}?\}/);
    assert.ok(guard, 'нет проверки answered перед записью кэша');
    assert.ok(!/writeJson/.test(guard[0]), 'в ветке провала не должно быть записи кэша');
    assert.match(guard[0], /onProgress/, 'о провале надо сказать пользователю, а не молчать');
  });

  test('порядок важен: проверка стоит ДО записи', () => {
    const iGuard = SRC.indexOf('if (!answered)');
    const iWrite = SRC.indexOf('store.writeJson(stationsPath()');
    assert.ok(iGuard > 0 && iWrite > 0);
    assert.ok(iGuard < iWrite, 'иначе провал успеет попасть в кэш');
  });

  test('в кэш кладётся счётчик — чтобы потом было что предъявить', () => {
    assert.match(SRC, /answered,/);
  });
});

describe('collectStations: счётчик на живой форме данных', () => {
  const fixtures = ['1', '2'];

  test('все страны ответили — answered равен asked', async () => {
    const res = await withFetch(async () => ({ 1: [{ station: { name: 'Матч ТВ' } }] }),
      () => broadcasters.collectStations(fixtures, ['RU', 'GB'], () => {}));
    assert.strictEqual(res.asked, 2);
    assert.strictEqual(res.answered, 2);
    assert.strictEqual(res.byCountry.size, 2);
  });

  test('все страны отвалились — answered ноль, карта пуста', async () => {
    const res = await withFetch(async () => { throw new Error('сеть'); },
      () => broadcasters.collectStations(fixtures, ['RU', 'GB'], () => {}));
    assert.strictEqual(res.answered, 0);
    assert.strictEqual(res.byCountry.size, 0);
  });

  // Тот самый двусмысленный случай: ответили все, но нашим матчам ничего не
  // соответствует. Карта пуста — как и при обрыве, — но answered не ноль.
  test('ответили, но по нашим матчам пусто — answered НЕ ноль', async () => {
    const res = await withFetch(async () => ({ 999: [{ station: { name: 'Чужой матч' } }] }),
      () => broadcasters.collectStations(fixtures, ['RU', 'GB'], () => {}));
    assert.strictEqual(res.answered, 2, 'это честный ответ, его кэшировать можно');
    assert.strictEqual(res.byCountry.size, 0);
  });

  test('часть стран отвалилась — считаются только ответившие', async () => {
    let n = 0;
    const res = await withFetch(async () => {
      if (++n % 2 === 0) throw new Error('сеть');
      return { 1: [{ station: { name: 'Матч ТВ' } }] };
    }, () => broadcasters.collectStations(fixtures, ['RU', 'GB', 'DE', 'FR'], () => {}));
    assert.strictEqual(res.asked, 4);
    assert.strictEqual(res.answered, 2);
  });
});

/** Подменяет сеть на время одного вызова: net.js выбирает fetch при каждом
 * запросе, так что достаточно подменить глобальный. */
async function withFetch(impl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: impl });
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}
