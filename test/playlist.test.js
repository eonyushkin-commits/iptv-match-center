'use strict';
// Разбор M3U — второе по хрупкости место после матчера, и по той же причине:
// оно встречает данные, которых мы не контролируем. Всё здесь калибровалось
// под конкретных провайдеров (номера групп, префиксы имён, отдельная строка
// #EXTGRP вместо стандартного group-title), а тестов не было ни одного.
//
// Страна нужна не для красоты: broadcasters.js сопоставляет станции FotMob
// только с каналами той же страны, так что ошибка здесь тихо ломает целый
// источник трансляций.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { parseText, isUrl } = require('../electron/playlist');

/** Короткий M3U из одной записи. */
function one(extinf, url = 'http://example/stream', extra = '') {
  return `#EXTM3U\n${extinf}\n${extra}${url}\n`;
}

describe('parseText: базовый разбор', () => {
  test('имя из tvg-name, а не из текста после запятой', () => {
    const { channels } = parseText(one('#EXTINF:-1 tvg-name="Матч ТВ" tvg-id="ch1",Матч ТВ HD'));
    assert.strictEqual(channels[0].name, 'Матч ТВ');
    assert.strictEqual(channels[0].id, 'ch1');
    assert.strictEqual(channels[0].url, 'http://example/stream');
  });

  test('без tvg-name берётся текст после запятой', () => {
    const { channels } = parseText(one('#EXTINF:-1 tvg-id="ch1",Первый канал'));
    assert.strictEqual(channels[0].name, 'Первый канал');
  });

  test('запись без URL не попадает в список', () => {
    const { channels } = parseText('#EXTM3U\n#EXTINF:-1 tvg-id="ch1",Оборванная запись\n');
    assert.strictEqual(channels.length, 0);
  });

  test('несколько каналов подряд', () => {
    const { channels } = parseText(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://a\n#EXTINF:-1 tvg-id="b",B\nhttp://b\n',
    );
    assert.deepStrictEqual(channels.map((c) => c.id), ['a', 'b']);
  });
});

describe('parseText: адрес EPG из заголовка', () => {
  test('url-tvg подхватывается', () => {
    const { epgUrl } = parseText('#EXTM3U url-tvg="http://p/epg.xml.gz"\n');
    assert.strictEqual(epgUrl, 'http://p/epg.xml.gz');
  });

  test('из списка через запятую берётся первый', () => {
    const { epgUrl } = parseText('#EXTM3U url-tvg="http://a/epg.xml,http://b/epg.xml"\n');
    assert.strictEqual(epgUrl, 'http://a/epg.xml');
  });

  test('понимает и x-tvg-url', () => {
    const { epgUrl } = parseText('#EXTM3U x-tvg-url="http://p/epg.xml"\n');
    assert.strictEqual(epgUrl, 'http://p/epg.xml');
  });

  test('нет атрибута — null, а не пустая строка', () => {
    assert.strictEqual(parseText('#EXTM3U\n').epgUrl, null);
  });
});

describe('parseText: группа канала', () => {
  test('стандартный group-title', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="Спорт",Канал'));
    assert.strictEqual(channels[0].group, 'Спорт');
  });

  // У текущего провайдера group-title нет вовсе, группа приходит отдельной
  // строкой; если есть оба, более специальный #EXTGRP выигрывает.
  test('#EXTGRP переопределяет group-title', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="Общие",Канал', 'http://x', '#EXTGRP:9. Sport\n'));
    assert.strictEqual(channels[0].group, '9. Sport');
  });
});

describe('parseText: страна канала', () => {
  test('tvg-country — самый явный сигнал, верхним регистром', () => {
    const { channels } = parseText(one('#EXTINF:-1 tvg-country="pl",Канал'));
    assert.strictEqual(channels[0].country, 'PL');
  });

  test('префикс имени: UK отображается в ISO-код GB', () => {
    const { channels } = parseText(one('#EXTINF:-1,UK: Sky Sports Main Event'));
    assert.strictEqual(channels[0].country, 'GB');
  });

  test('префикс INT означает «без страны», а не код «INT»', () => {
    const { channels } = parseText(one('#EXTINF:-1,INT: Eurosport 1'));
    assert.strictEqual(channels[0].country, null);
  });

  test('незнакомый двухбуквенный префикс проходит как есть', () => {
    const { channels } = parseText(one('#EXTINF:-1,IT: Sky Sport Calcio'));
    assert.strictEqual(channels[0].country, 'IT');
  });

  test('номер группы: 1..13 — российский блок', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="5. Фильмы",Канал'));
    assert.strictEqual(channels[0].country, 'RU');
  });

  test('номер группы по таблице', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="21. Italia",Канал'));
    assert.strictEqual(channels[0].country, 'IT');
  });

  test('страна словом в group-title — для провайдеров без кодов', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="Germany Sports",Канал'));
    assert.strictEqual(channels[0].country, 'DE');
  });

  // Подстрочное совпадение зажигалось бы на «Turkey» внутри чужого слова,
  // поэтому сравнение только по целым словам.
  test('слово страны ищется целиком, а не подстрокой', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="Naturkosmetik",Канал'));
    assert.strictEqual(channels[0].country, null);
  });

  test('ничего не подошло — null, а не выдумка', () => {
    const { channels } = parseText(one('#EXTINF:-1 group-title="Развлечения",Канал'));
    assert.strictEqual(channels[0].country, null);
  });

  test('tvg-country не остаётся в объекте канала', () => {
    const { channels } = parseText(one('#EXTINF:-1 tvg-country="fr",Канал'));
    assert.ok(!('tvgCountry' in channels[0]));
  });
});

describe('parseText: ранг качества', () => {
  const q = (name) => parseText(one(`#EXTINF:-1,${name}`)).channels[0].quality;

  test('порядок UHD > FHD > HD > без маркера > SD', () => {
    assert.ok(q('K UHD') > q('K FHD'));
    assert.ok(q('K FHD') > q('K HD'));
    assert.ok(q('K HD') > q('K'));
    assert.ok(q('K') > q('K SD'));
  });

  // Главное здесь: «+2» — это сдвиг по времени, а не живой эфир, и он должен
  // проигрывать даже SD-варианту живого канала.
  test('сдвиг по времени «+N» штрафуется сильнее всего', () => {
    assert.ok(q('K HD +2') < q('K SD'));
  });

  test('зеркала Double/backup идут ниже основного потока', () => {
    assert.ok(q('K HD Double') < q('K HD'));
  });
});

describe('isUrl', () => {
  test('http и https — ссылки', () => {
    assert.ok(isUrl('http://a/b.m3u'));
    assert.ok(isUrl('HTTPS://a/b.m3u'));
  });

  test('локальный путь — не ссылка', () => {
    assert.ok(!isUrl('C:\\playlists\\my.m3u8'));
    assert.ok(!isUrl('/home/user/my.m3u8'));
  });
});
