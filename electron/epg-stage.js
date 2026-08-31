'use strict';
const store = require('./store');
const epg = require('./epg');
const broadcasters = require('./broadcasters');

const { WINDOW_MS } = epg;

/**
 * Тяжёлая половина синхронизации: скачать EPG, разобрать фид, сопоставить
 * матчи с каналами и отсеять ложные заявки вещателей.
 *
 * Вынесена сюда отдельной функцией, а не написана прямо в воркере, по двум
 * причинам: её можно вызвать и проверить напрямую, без потоков (см.
 * test/epg-stage.test.js), а сам воркер остаётся десятком строк передачи
 * сообщений, где ломаться нечему.
 *
 * Работа здесь синхронная и долгая — на живых данных ~850 мс на разбор и
 * ~2.8 с на сопоставление. Именно поэтому этап целиком уезжает в рабочий
 * поток: так `programmes()` и `findBroadcastChannels()` остаются чистыми и
 * синхронными, а за отзывчивость окна отвечает граница потоков, а не
 * рассыпанные по коду уступки event loop'у.
 *
 * @param input.epgUrl адрес XMLTV-фида
 * @param input.cacheRoot папка данных — у рабочего потока свой реестр модулей,
 *        поэтому store.setRoot() нужно позвать и здесь
 * @param input.channels каналы плейлиста
 * @param input.fixtures предстоящие матчи
 * @param input.stationsByCountry имена станций от FotMob (см. broadcasters.collectStations)
 * @param onProgress (text) => void
 * @returns { epgByFixture, extraBroadcasts, stats } — Map'ы, а не объекты:
 *          structured clone переносит их как есть и сохраняет тип ключа,
 *          тогда как обычный объект превратил бы числовые id матчей в строки.
 */
async function run(input, onProgress = () => {}) {
  const { epgUrl, cacheRoot, channels, fixtures, stationsByCountry } = input;
  store.setRoot(cacheRoot);

  onProgress('Скачиваю EPG…');
  const feed = await epg.loadXmltv(epgUrl);

  onProgress('Разбираю передачи…');
  const { list: progList, channelCount, total } = epg.programmes(feed, channels, fixtures.map((f) => f.start));

  onProgress('Сопоставляю с каналами…');
  const epgByFixture = new Map();
  let done = 0;
  let lastReport = Date.now();
  for (const f of fixtures) {
    epgByFixture.set(f.id, new Set(
      epg.findBroadcastChannels(progList, f.home, f.away, f.start, f.homeShort, f.awayShort),
    ));
    // Уступать event loop'у здесь не нужно — поток ничей интерфейс не
    // держит. Но показать, что работа идёт, всё равно стоит: этап занимает
    // несколько секунд, и застывшая строка выглядит как сбой.
    done++;
    if (Date.now() - lastReport >= 300) {
      onProgress(`Сопоставляю с каналами… ${done}/${fixtures.length}`);
      lastReport = Date.now();
    }
  }

  // Заявки вещателей и их отсев — здесь же, рядом с разобранным фидом:
  // фильтры спрашивают у него, что реально шло на канале в это время.
  const byFixtureId = new Map(fixtures.map((f) => [f.id, f]));
  const progsByChannel = new Map();
  for (const p of progList) {
    if (!progsByChannel.has(p.channelId)) progsByChannel.set(p.channelId, []);
    progsByChannel.get(p.channelId).push(p);
  }

  const claims = broadcasters.claimsFromStations(stationsByCountry || new Map(), channels, fixtures);
  const extraBroadcasts = broadcasters.dropUnsound(
    claims,
    fixtures,
    (fid, chId) => epgByFixture.get(fid)?.has(chId) || false,
    // Противоречит ли EPG заявке — либо показывая на этом канале ДРУГОЙ наш
    // матч (та же планка «названы обе команды», что и в основном поиске),
    // либо показывая там вовсе другой вид спорта в момент свистка.
    (fid, chId) => {
      const f = byFixtureId.get(fid);
      if (!f) return false;
      const lo = f.start - WINDOW_MS;
      const hi = f.start + WINDOW_MS;
      const progs = (progsByChannel.get(chId) || []).filter((p) => p.start >= lo && p.start <= hi);
      if (!progs.length) return false;
      const otherFixture = fixtures.some((o) => o.id !== fid
        && epg.findBroadcastChannels(progs, o.home, o.away, f.start, o.homeShort, o.awayShort).length > 0);
      if (otherFixture) return true;
      // Другой вид спорта, идущий в момент свистка или начинающийся, пока
      // матч ещё идёт. `stop` — настоящее время конца из фида, поэтому
      // передача, которая просто ПРЕДШЕСТВУЕТ свистку, противоречием не
      // считается, а начавшаяся часом раньше и идущая насквозь — считается.
      return progs.some((p) => {
        if (!epg.isOtherSport(p.title)) return false;
        const ends = p.stop ?? (p.start + WINDOW_MS);
        const coversKickoff = p.start <= f.start && ends > f.start;
        const startsDuringMatch = p.start > f.start && p.start < f.start + WINDOW_MS;
        return coversKickoff || startsDuringMatch;
      });
    },
  );

  return {
    epgByFixture,
    extraBroadcasts,
    stats: { channels: channelCount, programmes: total },
  };
}

module.exports = { run };
