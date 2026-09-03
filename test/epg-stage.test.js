'use strict';
// Этап целиком, но без потоков и без сети: фид кладётся прямо в кэш, дальше
// всё идёт обычным путём. Ради этого он и вынесен из воркера отдельной чистой
// функцией.
//
// Проверяется главное заявление архитектуры: повторный прогон, на котором
// ничего не изменилось, не делает ни разбора, ни сопоставления.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const store = require('../main/store');
const feed = require('../main/epg/feed');
const stage = require('../main/epg-stage');
const teams = require('../main/teams');

const EPG_URL = 'http://example.invalid/epg.xml.gz';
const KICKOFF = Date.UTC(2026, 7, 30, 18, 0, 0);
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};

const XML = `<tv>
  <programme channel="ch1" start="${stamp(KICKOFF - 10 * 60000)}" stop="${stamp(KICKOFF + 110 * 60000)}">
    <title>Футбол. Барселона – Атлетик</title>
  </programme>
  <programme channel="ch2" start="${stamp(KICKOFF - 5 * 60000)}" stop="${stamp(KICKOFF + 115 * 60000)}">
    <title>Футбол. Ювентус – Милан</title>
  </programme>
  <programme channel="ch3" start="${stamp(KICKOFF - 30 * 60000)}" stop="${stamp(KICKOFF + 90 * 60000)}">
    <title>Хоккей. Швеция – Финляндия</title>
  </programme>
  <programme channel="ch1" start="${stamp(KICKOFF + 20 * 3600000)}" stop="${stamp(KICKOFF + 22 * 3600000)}">
    <title>Далеко за пределами любого окна</title>
  </programme>
</tv>`;

const CHANNELS = [
  { id: 'ch1', name: 'Спорт 1 HD', country: 'RU', quality: 3 },
  { id: 'ch2', name: 'Спорт 2 HD', country: 'RU', quality: 3 },
  { id: 'ch3', name: 'Спорт 3 HD', country: 'RU', quality: 3 },
];

const FIXTURES = [
  { id: 'f1', home: 'Barcelona', away: 'Athletic Club', homeShort: 'Barcelona', awayShort: 'Athletic', start: KICKOFF },
  { id: 'f2', home: 'Juventus', away: 'Milan', homeShort: 'Juventus', awayShort: 'Milan', start: KICKOFF },
];

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-stage-'));
  store.setRoot(tmp);
  // Фид кладём прямо в кэш — сети в тестах не место.
  fs.writeFileSync(feed.cachePath(EPG_URL), zlib.gzipSync(Buffer.from(XML, 'utf8')));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const input = (over = {}) => ({
  epgUrl: EPG_URL,
  cacheRoot: tmp,
  channels: CHANNELS,
  fixtures: FIXTURES,
  cachedLinks: null,
  stationsByCountry: new Map(),
  aliases: teams.SEED,
  ...over,
});

describe('этап целиком', () => {
  test('первый прогон: индекс строится, матчи сопоставляются', async () => {
    const r = await stage.run(input());
    assert.strictEqual(r.stats.indexReused, false, 'индекса ещё не было');
    assert.strictEqual(r.stats.matched, 2);
    assert.strictEqual(r.stats.reusedLinks, 0);
    assert.deepStrictEqual(r.links.f1.epg.map((e) => e.channelId), ['ch1']);
    assert.deepStrictEqual(r.links.f2.epg.map((e) => e.channelId), ['ch2']);
  });

  test('связь несёт улику — заголовок и время передачи', async () => {
    const r = await stage.run(input());
    const [e] = r.links.f1.epg;
    assert.strictEqual(e.title, 'Футбол. Барселона – Атлетик');
    assert.strictEqual(e.start, KICKOFF - 10 * 60000);
    assert.strictEqual(e.stop, KICKOFF + 110 * 60000);
  });

  /** Сохранённое так, как его отдаёт sync.js: связи вместе со всеми ключами. */
  const saved = (r, over = {}) => ({
    v: 1,
    feedVersion: r.feedVersion,
    channelsKey: r.channelsKey,
    matcherKey: r.matcherKey,
    byFixture: r.links,
    ...over,
  });

  // Ровно то, ради чего затевалась вся инкрементальность.
  test('повторный прогон: ни разбора, ни сопоставления', async () => {
    const first = await stage.run(input());
    const second = await stage.run(input({ cachedLinks: saved(first) }));
    assert.strictEqual(second.stats.indexReused, true, 'фид не менялся — разбирать нечего');
    assert.strictEqual(second.stats.matched, 0, 'матчи те же — сопоставлять нечего');
    assert.strictEqual(second.stats.reusedLinks, 2);
    assert.deepStrictEqual(second.links, first.links, 'результат обязан быть тем же');
  });

  test('перенесённый матч пересопоставляется, остальные — нет', async () => {
    const first = await stage.run(input());
    const moved = [{ ...FIXTURES[0], start: KICKOFF + 3 * 3600000 }, FIXTURES[1]];
    const second = await stage.run(input({ cachedLinks: saved(first), fixtures: moved }));
    assert.strictEqual(second.stats.matched, 1, 'только тот, у кого уехало время');
    assert.strictEqual(second.stats.reusedLinks, 1);
    assert.deepStrictEqual(second.links.f1.epg, [], 'на новом месте передачи нет');
    assert.deepStrictEqual(second.links.f2.epg, first.links.f2.epg, 'соседа это не касается');
  });

  // Живой сбой: пользователь сменил источник, фид перекачался, индекс
  // построился заново — а связи взялись готовыми от ПРЕЖНЕГО фида. Вся лента
  // стала «только FotMob». Проверка версии была потеряна при переносе этапа в
  // рабочий поток, и поймать это было нечем.
  describe('связи от чужого фида не переиспользуются', () => {
    test('сменилась версия фида — сопоставляем заново', async () => {
      const first = await stage.run(input());
      const stale = saved(first, { feedVersion: 'другой-фид', byFixture: { f1: { start: KICKOFF, epg: [] } } });
      const second = await stage.run(input({ cachedLinks: stale }));
      assert.strictEqual(second.stats.reusedLinks, 0, 'связи от другого фида брать нельзя');
      assert.strictEqual(second.stats.matched, 2);
      assert.deepStrictEqual(second.links.f1.epg.map((e) => e.channelId), ['ch1'], 'связь должна найтись заново');
    });

    test('сменился набор каналов — тоже заново', async () => {
      const first = await stage.run(input());
      const stale = saved(first, { channelsKey: 'другой-плейлист' });
      const second = await stage.run(input({ cachedLinks: stale }));
      assert.strictEqual(second.stats.reusedLinks, 0);
      assert.strictEqual(second.stats.matched, 2);
    });

    test('чужая версия формата — как будто кэша нет', async () => {
      const first = await stage.run(input());
      const second = await stage.run(input({ cachedLinks: saved(first, { v: 99 }) }));
      // sync.js такое до этапа не донесёт, но этап не должен на это полагаться.
      assert.ok(second.links.f1.epg.length, 'связи обязаны быть, откуда бы они ни взялись');
    });

    test('кэша нет вовсе — не падаем', async () => {
      const r = await stage.run(input({ cachedLinks: null }));
      assert.strictEqual(r.stats.reusedLinks, 0);
      assert.strictEqual(r.stats.matched, 2);
    });
  });

  // Кэш зависит не только от ДАННЫХ (фид, каналы), но и от того, ЧЕМ он
  // посчитан. Без этого правка алгоритма не вступала в силу до смены фида —
  // так ложный канал Disney пережил собственное исправление, — а правка
  // teams.json не влияла ни на что вообще, обнуляя главную идею словаря.
  describe('кэш зависит от самого сопоставления', () => {
    test('этап возвращает отпечаток, чтобы его было где сохранить', async () => {
      const r = await stage.run(input());
      assert.ok(r.matcherKey, 'без него sync.js нечего класть рядом со связями');
    });

    test('правка словаря имён сбрасывает кэш — иначе она ни на что не влияет', async () => {
      const first = await stage.run(input());
      const withNewAlias = { ...teams.SEED, 'Athletic Club': ['Атлетик Бильбао'] };
      const second = await stage.run(input({ cachedLinks: saved(first), aliases: withNewAlias }));
      assert.strictEqual(second.stats.reusedLinks, 0, 'словарь другой — связи надо считать заново');
      assert.strictEqual(second.stats.matched, 2);
    });

    test('тот же словарь — кэш остаётся годным', async () => {
      const first = await stage.run(input());
      const second = await stage.run(input({ cachedLinks: saved(first), aliases: { ...teams.SEED } }));
      assert.strictEqual(second.stats.reusedLinks, 2, 'копия того же словаря не повод пересчитывать');
    });

    test('чужой отпечаток сопоставления — считаем заново', async () => {
      const first = await stage.run(input());
      const stale = saved(first, { matcherKey: 'алгоритм-был-другой' });
      const second = await stage.run(input({ cachedLinks: stale }));
      assert.strictEqual(second.stats.reusedLinks, 0);
      assert.strictEqual(second.stats.matched, 2);
    });

    test('кэш без отпечатка вовсе (записан прежней версией) — считаем заново', async () => {
      const first = await stage.run(input());
      const old = saved(first);
      delete old.matcherKey;
      const second = await stage.run(input({ cachedLinks: old }));
      assert.strictEqual(second.stats.reusedLinks, 0);
    });
  });

  test('смена набора каналов заставляет перестроить индекс', async () => {
    await stage.run(input());
    const fewer = await stage.run(input({ channels: CHANNELS.slice(0, 1) }));
    assert.strictEqual(fewer.stats.indexReused, false, 'отбор передач шёл по каналам — индекс другой');
    assert.deepStrictEqual(fewer.links.f2.epg, [], 'ch2 из плейлиста убрали');
  });

  test('передачи вне окон вокруг свистков в сопоставление не попадают', async () => {
    const r = await stage.run(input());
    // «Далеко за пределами» лежит в индексе, но в окно не входит; косвенно это
    // видно по тому, что ch1 у f1 ровно один и это нужная передача.
    assert.strictEqual(r.links.f1.epg.length, 1);
    assert.ok(r.stats.epgProgrammes >= 4, 'в индексе при этом все передачи');
  });
});

describe('заявки вещателей', () => {
  const stations = new Map([['RU', new Map([['f1', ['Спорт 1']], ['f2', ['Спорт 3']]])]]);

  test('заявка, подтверждённая EPG, доживает до результата', async () => {
    const r = await stage.run(input({ stationsByCountry: stations }));
    assert.ok(r.extraBroadcasts.get('f1')?.has('ch1'), 'Спорт 1 назван и подтверждён телепрограммой');
  });

  test('заявка на канал, где EPG показывает другой вид спорта, выбрасывается', async () => {
    const r = await stage.run(input({ stationsByCountry: stations }));
    assert.ok(!r.extraBroadcasts.get('f2')?.has('ch3'), 'на ch3 в это время хоккей');
  });

  test('без имён станций отсев просто не работает и ничего не ломает', async () => {
    const r = await stage.run(input());
    assert.strictEqual(r.extraBroadcasts.size, 0);
  });
});

describe('кандидаты в словарь', () => {
  test('нечёткое совпадение предлагается, а не применяется', async () => {
    const r = await stage.run(input());
    // «Ювентус» -> yuventus добирается до Juventus только Левенштейном.
    assert.ok(r.candidates.has('Juventus'), 'нечёткое попадание должно попасть в предложения');
  });
});
