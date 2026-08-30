'use strict';
// Кэш EPG-фида: раздельный по URL, самоочищающийся, переживающий битый файл.
// Всё три свойства появились из живых аварий (см. CLAUDE.md и историю
// правок), и все три невидимы снаружи — сетка просто оказывается пустой или
// синк падает, без внятного сообщения. Поэтому здесь настоящий HTTP-сервер
// на localhost и настоящая папка кэша во временном каталоге: без сети, но и
// без подмены файловой системы заглушками.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const store = require('../electron/store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-cache-'));
store.setRoot(tmp);

const { loadXmltv } = require('../electron/epg');

const XML = '<tv><programme start="20260830140000 +0000" channel="ch1"><title>Тест</title></programme></tv>';
const TTL_MS = 6 * 3600 * 1000;

let server;
let url;
let hits = 0;

/** Файл кэша, каким его назовёт epg.js для этого адреса. */
function cacheFileFor(u) {
  const hash = require('node:crypto').createHash('sha1').update(u).digest('hex').slice(0, 16);
  return path.join(tmp, `epg-${hash}.xml.gz`);
}

/** Посторонний файл кэша — как будто от другого провайдера. */
function foreignFile(name, ageMs) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, zlib.gzipSync(Buffer.from('<tv></tv>')));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

describe('loadXmltv: кэш', () => {
  before(() => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(zlib.gzipSync(Buffer.from(XML, 'utf8')));
    });
    server.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}/epg.xml.gz`;
      resolve();
    });
  }));

  after(() => new Promise((resolve) => {
    server.close(resolve);
    fs.rmSync(tmp, { recursive: true, force: true });
  }));

  test('первый заход качает и распаковывает фид', async () => {
    const xml = await loadXmltv(url);
    assert.match(xml, /<programme/);
    assert.strictEqual(hits, 1);
    assert.ok(fs.existsSync(cacheFileFor(url)), 'файл кэша не создан');
  });

  test('второй заход берёт из кэша, не ходит в сеть', async () => {
    const xml = await loadXmltv(url);
    assert.match(xml, /<programme/);
    assert.strictEqual(hits, 1, 'сходил в сеть, хотя кэш свежий');
  });

  test('битый файл кэша не блокирует синк на все шесть часов TTL', async () => {
    // mtime свежий, значит по одному только TTL перекачки не будет, а
    // gunzip падает на каждом заходе — раньше это чинилось только руками.
    fs.writeFileSync(cacheFileFor(url), Buffer.from('это не gzip'));
    const xml = await loadXmltv(url);
    assert.match(xml, /<programme/);
    assert.strictEqual(hits, 2, 'не перекачал битый кэш');
  });

  test('протухшие файлы других провайдеров удаляются, свежие остаются', async () => {
    const stale = foreignFile('epg-0123456789abcdef.xml.gz', TTL_MS + 60000);
    const fresh = foreignFile('epg-fedcba9876543210.xml.gz', 60000);
    const unrelated = path.join(tmp, 'guide.json');
    fs.writeFileSync(unrelated, '{}');

    // Важно: без перекачки. Пока текущий фид свежий, закачки не происходит
    // вовсе — если чистить только после неё, чужой мусор лежит до ближайшего
    // обновления фида, а это до шести часов TTL.
    const before = hits;
    await loadXmltv(url);
    assert.strictEqual(hits, before, 'сходил в сеть, хотя кэш свежий');

    assert.ok(!fs.existsSync(stale), 'протухший чужой файл не удалён');
    assert.ok(fs.existsSync(fresh), 'свежий чужой файл удалён зря');
    assert.ok(fs.existsSync(unrelated), 'удалено что-то, кроме файлов кэша EPG');
    assert.ok(fs.existsSync(cacheFileFor(url)), 'удалён текущий файл кэша');
  });

  test('разные адреса кэшируются раздельно', async () => {
    const other = `${url}?provider=2`;
    assert.notStrictEqual(cacheFileFor(other), cacheFileFor(url));
    const before = hits;
    await loadXmltv(other);
    assert.strictEqual(hits, before + 1, 'подставил кэш другого провайдера');
  });
});
