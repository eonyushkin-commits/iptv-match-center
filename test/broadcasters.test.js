'use strict';
// dropUnsound() — три правила, каждое выведенное из живого аудита, где
// источник «где смотреть» FotMob дал 21 ложную привязку из 242. Правила
// неочевидные и взаимозависимые (подтверждение из EPG выигрывает слот,
// неподтверждённая ничья убивает обе стороны), а тестов на них не было.
//
// Причина всей этой машинерии: источник отвечает на уровне
// правообладателя, а не «какой канал в какую минуту», — он спокойно
// называет один канал сразу на пять матчей, два из которых идут
// одновременно.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { dropUnsound, matchingChannelIds } = require('../electron/broadcasters');

const T = Date.UTC(2026, 7, 30, 18, 0, 0);
const HOUR = 3600 * 1000;

/** Заявки источника: { fixtureId: [channelId, ...] } -> Map<id, Set>. */
const claims = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));
/** Плоский снимок результата, удобный для сравнения. */
const snapshot = (map) => Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]));

const NO = () => false;

// Имя станции у FotMob («Match! Football 1») часто накрывает несколько
// разных tvg-id плейлиста — варианты качества одного канала. Раньше здесь
// стоял `find()`, бравший первый по порядку: выбор качества зависел от того,
// как провайдер перечислил каналы.
describe('matchingChannelIds: берутся ВСЕ подходящие каналы', () => {
  const ru = [
    { id: 'm1', name: 'Матч! Футбол 1 FHD' },
    { id: 'm2', name: 'Матч! Футбол 1 HD' },
    { id: 'm3', name: 'Матч! Футбол 1 HD Double' },
    { id: 'm4', name: 'Матч! Футбол 1 SD' },
    { id: 'x1', name: 'Матч! Футбол 2 HD' },
    { id: 'x2', name: 'Первый канал HD' },
  ];

  test('все варианты качества, а не первый по порядку', () => {
    assert.deepStrictEqual([...matchingChannelIds('Match! Football 1', ru)].sort(), ['m1', 'm2', 'm3', 'm4']);
  });

  test('порядок каналов в плейлисте не влияет на результат', () => {
    const reversed = [...ru].reverse();
    assert.deepStrictEqual(
      [...matchingChannelIds('Match! Football 1', ru)].sort(),
      [...matchingChannelIds('Match! Football 1', reversed)].sort(),
    );
  });

  // Цифровой гейт в similarity(): «Футбол 1» не должен утащить «Футбол 2».
  test('соседний канал с другим номером не попадает', () => {
    assert.ok(!matchingChannelIds('Match! Football 1', ru).has('x1'));
  });

  test('несколько записей с одним tvg-id схлопываются в один id', () => {
    const dup = [{ id: 'same', name: 'Sky Sports Main Event HD' }, { id: 'same', name: 'Sky Sports Main Event UHD' }];
    assert.deepStrictEqual([...matchingChannelIds('Sky Sports Main Event', dup)], ['same']);
  });

  test('ничего не подошло — пустое множество', () => {
    assert.strictEqual(matchingChannelIds('DAZN.com (FR)', ru).size, 0);
  });

  test('канал без tvg-id пропускается', () => {
    assert.strictEqual(matchingChannelIds('Первый канал', [{ id: null, name: 'Первый канал HD' }]).size, 0);
  });
});

describe('dropUnsound: правило 1 — один канал на два пересекающихся матча', () => {
  const fixtures = [
    { id: 'a', start: T },
    { id: 'b', start: T + 15 * 60000 }, // через 15 минут — пересекаются
  ];

  test('ни один не подтверждён EPG — выкидываются оба', () => {
    const res = dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, NO, NO);
    assert.deepStrictEqual(snapshot(res), {}, 'неразрешимую ничью надо выкидывать целиком');
  });

  test('подтверждённый EPG выигрывает слот, второй выбывает', () => {
    const confirmed = (fid, ch) => fid === 'a' && ch === 'ch1';
    const res = dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, confirmed, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'] });
  });

  test('подтверждены оба — оба остаются', () => {
    const res = dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), fixtures, () => true, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'], b: ['ch1'] });
  });

  test('матчи не пересекаются по времени — правило не применяется', () => {
    const apart = [{ id: 'a', start: T }, { id: 'b', start: T + 3 * HOUR }];
    const res = dropUnsound(claims({ a: ['ch1'], b: ['ch1'] }), apart, NO, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'], b: ['ch1'] });
  });

  test('пересекаются, но каналы разные — конфликта нет', () => {
    const res = dropUnsound(claims({ a: ['ch1'], b: ['ch2'] }), fixtures, NO, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'], b: ['ch2'] });
  });

  test('конфликт убивает только спорный канал, остальные у матча остаются', () => {
    const res = dropUnsound(claims({ a: ['ch1', 'ch9'], b: ['ch1'] }), fixtures, NO, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch9'] });
  });
});

describe('dropUnsound: правило 2 — EPG показывает там другой матч', () => {
  const fixtures = [{ id: 'a', start: T }];

  test('прямое противоречие — заявка выкидывается', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), fixtures, NO, () => true);
    assert.deepStrictEqual(snapshot(res), {});
  });

  // Собственное подтверждение из EPG сильнее: если наш же поиск по
  // заголовкам нашёл этот матч на этом канале, «там другой матч» — шум.
  test('своё подтверждение из EPG перевешивает противоречие', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), fixtures, () => true, () => true);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'] });
  });

  test('EPG молчит — заявка живёт (там, где проверять нечем)', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), fixtures, NO, NO);
    assert.deepStrictEqual(snapshot(res), { a: ['ch1'] });
  });
});

describe('dropUnsound: форма результата', () => {
  test('матч, потерявший все каналы, исчезает из карты целиком', () => {
    const res = dropUnsound(claims({ a: ['ch1'] }), [{ id: 'a', start: T }], NO, () => true);
    assert.strictEqual(res.has('a'), false, 'остался пустой Set вместо удаления');
  });

  test('пустой вход не ломается', () => {
    assert.deepStrictEqual(snapshot(dropUnsound(new Map(), [], NO, NO)), {});
  });

  test('заявка на матч, которого нет в списке фикстур, не роняет проверку', () => {
    // startById.get() вернёт undefined — арифметика по времени станет NaN.
    const res = dropUnsound(claims({ zzz: ['ch1'] }), [{ id: 'a', start: T }], NO, NO);
    assert.deepStrictEqual(snapshot(res), { zzz: ['ch1'] });
  });
});
