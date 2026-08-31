'use strict';
// Тяжёлый этап синка целиком: скачать фид, разобрать, сопоставить, отсеять
// заявки вещателей. В приложении он выполняется в рабочем потоке
// (electron/sync-worker.js), но написан отдельной функцией именно для того,
// чтобы его можно было вызвать и проверить напрямую — потоки тут ничего не
// добавляют к смыслу, а мешают отладке.
//
// Сети нет: EPG отдаёт локальный HTTP-сервер, вещатели приходят готовым
// аргументом (в приложении их приносит main-процесс).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const stage = require('../electron/epg-stage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-stage-'));
const K = Date.UTC(2026, 7, 30, 18, 0, 0);
const at = (offsetMin) => new Date(K + offsetMin * 60000)
  .toISOString().replace(/[-:T]/g, '').slice(0, 14);

// «Матч ТВ» показывает сам матч, «Спорт 1» — в это же время другой вид
// спорта, «Кино ТВ» вообще не про футбол.
const XML = `<tv>
  <programme start="${at(0)} +0000" stop="${at(120)} +0000" channel="match">
    <title>⋗ Футбол. Испания. Барселона – Атлетик</title>
  </programme>
  <programme start="${at(-30)} +0000" stop="${at(90)} +0000" channel="sport1">
    <title>Баскетбол. Швеция – Франция</title>
  </programme>
  <programme start="${at(0)} +0000" stop="${at(120)} +0000" channel="kino">
    <title>Хороший фильм</title>
  </programme>
</tv>`;

const channels = [
  { id: 'match', name: 'Матч ТВ HD', country: 'RU', quality: 3 },
  { id: 'sport1', name: 'Спорт 1 HD', country: 'RU', quality: 3 },
  { id: 'kino', name: 'Кино ТВ HD', country: 'RU', quality: 3 },
];
const fixtures = [{
  id: 777, start: K, home: 'Barcelona', away: 'Athletic Club',
  homeShort: 'Barcelona', awayShort: 'Athletic',
}];

let server;
let epgUrl;

describe('epg-stage: тяжёлый этап синка', () => {
  before(() => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end(zlib.gzipSync(Buffer.from(XML, 'utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      epgUrl = `http://127.0.0.1:${server.address().port}/epg.xml.gz`;
      resolve();
    });
  }));

  after(() => new Promise((resolve) => {
    server.close(resolve);
    fs.rmSync(tmp, { recursive: true, force: true });
  }));

  const run = (stationsByCountry) => stage.run({
    epgUrl, cacheRoot: tmp, channels, fixtures, stationsByCountry,
  });

  test('находит трансляцию по заголовку передачи', async () => {
    const { epgByFixture } = await run(new Map());
    assert.deepStrictEqual([...epgByFixture.get(777)], ['match']);
  });

  test('возвращает статистику по фиду', async () => {
    const { stats } = await run(new Map());
    assert.strictEqual(stats.channels, 3);
    assert.strictEqual(stats.programmes, 3);
  });

  test('id матча остаётся числом, а не превращается в строку', async () => {
    const { epgByFixture } = await run(new Map());
    assert.ok(epgByFixture.has(777), 'ключ Map должен быть числом 777');
    assert.ok(!epgByFixture.has('777'));
  });

  // Ключи в ответе FotMob строковые — вся связка развалилась бы молча, если
  // бы claimsFromStations() не приводила их обратно к типу наших id.
  test('заявка вещателя доезжает до результата', async () => {
    const stations = new Map([['RU', new Map([['777', ['Матч ТВ']]])]]);
    const { extraBroadcasts } = await run(stations);
    assert.deepStrictEqual([...(extraBroadcasts.get(777) || [])], ['match']);
  });

  test('заявка отсеивается, если EPG показывает там другой вид спорта', async () => {
    const stations = new Map([['RU', new Map([['777', ['Спорт 1']]])]]);
    const { extraBroadcasts } = await run(stations);
    assert.strictEqual(extraBroadcasts.has(777), false, 'баскетбол в момент свистка — не наш матч');
  });

  test('канал без единой передачи в окне проверить нечем — заявка живёт', async () => {
    const withEmpty = [...channels, { id: 'empty', name: 'Пустой HD', country: 'RU', quality: 3 }];
    const { extraBroadcasts } = await stage.run({
      epgUrl, cacheRoot: tmp, channels: withEmpty, fixtures,
      stationsByCountry: new Map([['RU', new Map([['777', ['Пустой']]])]]),
    });
    assert.deepStrictEqual([...(extraBroadcasts.get(777) || [])], ['empty']);
  });

  test('без данных о вещателях этап всё равно отрабатывает', async () => {
    const { epgByFixture, extraBroadcasts } = await stage.run({
      epgUrl, cacheRoot: tmp, channels, fixtures, stationsByCountry: undefined,
    });
    assert.deepStrictEqual([...epgByFixture.get(777)], ['match']);
    assert.strictEqual(extraBroadcasts.size, 0);
  });
});
