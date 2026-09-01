'use strict';
// dropUnsound() — правила, выведенные из живого аудита, где источник «где
// смотреть» FotMob дал 21 ложную привязку из 242. Правила неочевидные и
// взаимозависимые: подтверждение из EPG выигрывает слот, а неразрешимая
// ничья убивает обе стороны.
//
// Причина всей машинерии: источник отвечает на уровне ПРАВООБЛАДАТЕЛЯ, а не
// «какой канал в какую минуту», — он спокойно называет один канал сразу на
// пять матчей, два из которых идут одновременно.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { tokens } = require('../main/normalize');

const { dropUnsound, prepareChannels, matchingIds } = require('../main/broadcasters');

const T = Date.UTC(2026, 7, 30, 18, 0, 0);
const HOUR = 3600 * 1000;

/** Заявки: { fixtureId: [channelId, ...] } -> Map<id, Map<ch, улика>>. */
const claims = (obj) => new Map(Object.entries(obj).map(([k, v]) =>
  [k, new Map(v.map((ch) => [ch, { station: `станция ${ch}`, country: 'XX' }]))]));
const snapshot = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v.keys()].sort()]));

const NO = () => false;

describe('сопоставление имени станции с каналами: берутся ВСЕ подходящие', () => {
  const match = (name, chans) => matchingIds(tokens(name), prepareChannels(chans));
  const ru = [
    { id: 'm1', name: 'Матч! Футбол 1 FHD' },
    { id: 'm2', name: 'Матч! Футбол 1 HD' },
    { id: 'm3', name: 'Матч! Футбол 1 HD Double' },
    { id: 'm4', name: 'Матч! Футбол 1 SD' },
    { id: 'x1', name: 'Матч! Футбол 2 HD' },
    { id: 'x2', name: 'Первый канал HD' },
  ];

  test('все варианты качества, а не первый по порядку', () => {
    assert.deepStrictEqual([...match('Match! Football 1', ru)].sort(), ['m1', 'm2', 'm3', 'm4']);
  });

  test('порядок каналов в плейлисте не влияет на результат', () => {
    assert.deepStrictEqual(
      [...match('Match! Football 1', ru)].sort(),
      [...match('Match! Football 1', [...ru].reverse())].sort(),
    );
  });

  // Цифровой гейт в similarity(): «Футбол 1» не должен утащить «Футбол 2».
  test('соседний канал с другим номером не попадает', () => {
    assert.ok(!match('Match! Football 1', ru).has('x1'));
  });

  test('потоковый сервис не находит ничего (нужно ТОЧНОЕ совпадение)', () => {
    assert.strictEqual(match('DAZN.com (FR)', ru).size, 0);
  });

  test('канал без tvg-id пропускается', () => {
    assert.strictEqual(match('Первый канал', [{ id: null, name: 'Первый канал HD' }]).size, 0);
  });
});

describe('правило 1 — один канал на два пересекающихся матча', () => {
  const fixtures = [{ id: 'a', start: T }, { id: 'b', start: T + 15 * 60000 }];

  test('ни один не подтверждён EPG — выкидываются оба', () => {
    assert.deepStrictEqual(snapshot(dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, NO, NO)), {});
  });

  test('подтверждённый EPG выигрывает слот, второй выбывает', () => {
    const confirmed = (fid, ch) => fid === 'a' && ch === 'ch1';
    assert.deepStrictEqual(snapshot(dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, confirmed, NO)), { a: ['ch1'] });
  });

  test('подтверждены оба — оба остаются', () => {
    assert.deepStrictEqual(
      snapshot(dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, () => true, NO)),
      { a: ['ch1'], b: ['ch1'] },
    );
  });

  test('матчи не пересекаются по времени — правило не применяется', () => {
    const apart = [{ id: 'a', start: T }, { id: 'b', start: T + 3 * HOUR }];
    assert.deepStrictEqual(
      snapshot(dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), apart, NO, NO)),
      { a: ['ch1'], b: ['ch1'] },
    );
  });

  test('конфликт убивает только спорный канал, остальные у матча остаются', () => {
    assert.deepStrictEqual(
      snapshot(dropUnsound(claims({ a: ['ch1', 'ch9'], b: ['ch1'] }), fixtures, NO, NO)),
      { a: ['ch9'] },
    );
  });
});

describe('правило 2 — EPG показывает там другой матч', () => {
  const fixtures = [{ id: 'a', start: T }];

  test('прямое противоречие — заявка выкидывается', () => {
    assert.deepStrictEqual(snapshot(dropUnsound(claims({ a: ['ch1'] }), fixtures, NO, () => true)), {});
  });

  test('своё подтверждение из EPG перевешивает противоречие', () => {
    assert.deepStrictEqual(
      snapshot(dropUnsound(claims({ a: ['ch1'] }), fixtures, () => true, () => true)),
      { a: ['ch1'] },
    );
  });

  test('EPG молчит — заявка живёт (там, где проверять нечем)', () => {
    assert.deepStrictEqual(snapshot(dropUnsound(claims({ a: ['ch1'] }), fixtures, NO, NO)), { a: ['ch1'] });
  });
});

describe('форма результата', () => {
  test('матч, потерявший все каналы, исчезает целиком', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), [{ id: 'a', start: T }], NO, () => true);
    assert.strictEqual(res.has('a'), false);
  });

  test('улика переживает отсев', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), [{ id: 'a', start: T }], NO, NO);
    assert.deepStrictEqual(res.get('a').get('ch1'), { station: 'станция ch1', country: 'XX' });
  });

  test('пустой вход не ломается', () => {
    assert.deepStrictEqual(snapshot(dropUnsound(new Map(), [], NO, NO)), {});
  });

  test('заявка на матч не из списка не роняет проверку', () => {
    const res = dropUnsound(claims({ zzz: ['ch1'] }), [{ id: 'a', start: T }], NO, NO);
    assert.deepStrictEqual(snapshot(res), { zzz: ['ch1'] });
  });
});
