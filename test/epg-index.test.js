'use strict';
// Разбор XMLTV. Чистая функция от буфера и набора каналов — ни сети, ни
// диска. Именно эта чистота позволяет при нужде унести разбор в рабочий
// поток, не трогая ничего вокруг.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { build, firstAtOrAfter, parseTime, channelsKey } = require('../main/epg/index');

const XML = `<?xml version="1.0"?>
<tv>
  <channel id="ch1"><display-name>Спорт 1</display-name></channel>
  <programme channel="ch1" start="20260830180000 +0000" stop="20260830200000 +0000">
    <title>Футбол. Барселона – Атлетик</title>
    <desc>Испания</desc>
  </programme>
  <programme channel="ch2" start="20260830170000 +0000" stop="20260830183000 +0000">
    <title>&#34;Эльче&#34; – Реал</title>
  </programme>
  <programme channel="ch9" start="20260830190000 +0000" stop="20260830200000 +0000">
    <title>Канал не из плейлиста</title>
  </programme>
  <programme channel="ch1" start="20260830210000 +0000">
    <title>Без времени окончания</title>
  </programme>
  <programme channel="ch1" start="20260830220000 +0000" stop="20260830230000 +0000">
    <title></title>
  </programme>
</tv>`;

describe('build: отбор и разбор', () => {
  const { rows, channelCount, total } = build(XML, ['ch1', 'ch2']);

  test('берёт только каналы из плейлиста', () => {
    assert.ok(!rows.some((r) => r[0] === 'ch9'), 'ch9 в плейлисте нет');
    assert.strictEqual(channelCount, 2);
  });

  test('передача без заголовка пропускается', () => {
    assert.ok(!rows.some((r) => r[3] === ''));
  });

  test('total считает всё на известных каналах, до отсева по заголовку', () => {
    assert.strictEqual(total, 4, 'четыре записи на ch1/ch2, включая пустую по заголовку');
  });

  test('отсортировано по началу', () => {
    const starts = rows.map((r) => r[1]);
    assert.deepStrictEqual(starts, [...starts].sort((a, b) => a - b));
  });

  test('XML-сущности раскрываются (иначе «34» становится токеном-цифрой и рушит сравнение имён)', () => {
    const elche = rows.find((r) => r[0] === 'ch2');
    assert.strictEqual(elche[3], '"Эльче" – Реал');
  });

  test('конец передачи читается, а при отсутствии равен null', () => {
    const withStop = rows.find((r) => r[3].startsWith('Футбол'));
    assert.strictEqual(withStop[2], Date.UTC(2026, 7, 30, 20, 0, 0));
    const without = rows.find((r) => r[3] === 'Без времени окончания');
    assert.strictEqual(without[2], null);
  });

  test('строка и буфер дают одинаковый результат', () => {
    const fromBuffer = build(Buffer.from(XML, 'utf8'), ['ch1', 'ch2']);
    assert.deepStrictEqual(fromBuffer.rows, rows);
  });

  test('индекс не зависит от матчей — в нём нет фильтра по окнам свистков', () => {
    // Это и есть причина, по которой его можно строить один раз на фид:
    // расписание может смениться, а индекс останется годным.
    assert.ok(rows.length >= 3, 'все передачи известных каналов, а не только близкие к матчу');
  });
});

describe('build: не путает похожие теги', () => {
  test('<programmes> не принимается за <programme>', () => {
    const xml = '<tv><programmes count="5"></programmes>'
      + '<programme channel="ch1" start="20260830180000 +0000"><title>Матч</title></programme></tv>';
    const { rows } = build(xml, ['ch1']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0][3], 'Матч');
  });
});

describe('parseTime', () => {
  test('со смещением', () => {
    assert.strictEqual(parseTime('20260830180000 +0200'), Date.UTC(2026, 7, 30, 16, 0, 0));
  });
  test('с отрицательным смещением', () => {
    assert.strictEqual(parseTime('20260830180000 -0300'), Date.UTC(2026, 7, 30, 21, 0, 0));
  });
  test('без смещения — как UTC', () => {
    assert.strictEqual(parseTime('20260830180000'), Date.UTC(2026, 7, 30, 18, 0, 0));
  });
  test('мусор — null', () => {
    assert.strictEqual(parseTime('когда-то'), null);
  });
});

describe('firstAtOrAfter', () => {
  const list = [10, 20, 30, 40].map((n) => ({ start: n }));
  test('точное попадание', () => assert.strictEqual(firstAtOrAfter(list, 30), 2));
  test('между элементами', () => assert.strictEqual(firstAtOrAfter(list, 25), 2));
  test('раньше всех', () => assert.strictEqual(firstAtOrAfter(list, 0), 0));
  test('позже всех', () => assert.strictEqual(firstAtOrAfter(list, 99), 4));
  test('пустой список', () => assert.strictEqual(firstAtOrAfter([], 5), 0));
});

describe('channelsKey', () => {
  test('не зависит от порядка', () => {
    assert.strictEqual(channelsKey(['a', 'b', 'c']), channelsKey(['c', 'a', 'b']));
  });
  test('меняется при смене набора — иначе индекс от чужого плейлиста сочли бы годным', () => {
    assert.notStrictEqual(channelsKey(['a', 'b']), channelsKey(['a', 'b', 'c']));
  });
});
