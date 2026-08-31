'use strict';
const { tokens, similarityTokens } = require('./normalize');
// Same undocumented-FotMob-API pattern as fotmob.js -- no key, must go
// through electron.net.fetch (plain fetch gets the same bot-protection
// block Sofascore/TheSportsDB do). Общий вызов с таймаутом — в net.js.
const { fetchJson } = require('./net');

/**
 * FotMob's own "Where to watch" data, one call per country. Found live: the
 * `matchId` query parameter is entirely ignored by this endpoint (verified
 * three different ids, byte-identical responses) -- `countryCode` is the
 * only thing that changes the result, so a single fixed dummy id works for
 * every call. Response is a flat `{ [fotmobMatchId]: [{ station: {name},
 * ... }] }` map covering every match FotMob has broadcaster data for in that
 * country right now (hundreds, not just the one "requested") -- cheap
 * (~300 KB), fast (sub-second cold, near-instant on repeat thanks to
 * Chromium's own HTTP cache), no pagination or date range needed.
 */
async function fetchListings(countryCode) {
  const url = `https://www.fotmob.com/api/data/tvlistings?matchId=1&countryCode=${countryCode}`;
  return fetchJson(url, `tvlistings ${countryCode}`);
}

// Fetched one country at a time, sequentially, took ~47s for ~39 countries
// on a live run (vs. the ~16s baseline for a full sync) -- each call is
// only a few hundred ms, so the wait was pure round-trip latency stacking
// up. Fetching all countries fully in parallel would fix that, but a batch
// this size hitting the same undocumented endpoint at once risks the exact
// rate-limit wall found earlier this project (Wikidata's unbounded
// Promise.all silently returning 0/393) -- chunking to a modest concurrency
// keeps the speedup without that risk.
const BATCH_SIZE = 8;

// Kickoff to final whistle, generously. Only used to decide whether two
// claims on one channel overlap, so erring long is the safe direction.
const MATCH_LEN_MS = 105 * 60 * 1000;

/**
 * Drops claims this source can be shown to have gotten wrong. FotMob's
 * tvlistings answers "who holds the rights / which broadcaster carries
 * this", NOT "which specific linear channel at which minute" -- verified
 * live and painfully: it listed "Match TV" for five different RPL/FNL
 * matches at once (two of them kicking off simultaneously), and the EPG
 * proved that channel was actually showing motorsport, then Real Madrid -
 * Málaga, then a post-match studio show at those exact times (the real
 * matches were on Матч! Премьер, which the EPG path already found by
 * itself). Same shape in the UK, the case that motivated this whole
 * source: Sky lists a match on both Main Event and Sky Sports Football,
 * and two simultaneous fixtures each claim both channels.
 *
 * Two purely local checks, no extra requests, no per-country allowlist to
 * maintain (a hardcoded country list was the obvious alternative but it
 * would be a snapshot of one week's data -- these rules hold for any
 * country in any week):
 *
 *   1. One channel, two fixtures overlapping in time -- physically
 *      impossible, so unless the EPG independently confirms one of them,
 *      neither can be trusted and both go.
 *   2. The EPG on that channel at that time names a DIFFERENT fixture we
 *      track -- a direct contradiction, drop it.
 *
 * Between them these caught every one of the 21 bad claims found during
 * the live audit, across all 9 countries that had any, while leaving the
 * ~108 clean ones alone. What they can't do is prove a surviving claim
 * right: where the EPG carries nothing at all (exactly the blind spot this
 * source exists to cover) there is simply nothing to check against.
 */
function dropUnsound(result, fixtures, epgConfirmed, epgClaimsOther) {
  const startById = new Map(fixtures.map((f) => [f.id, f.start]));

  // channelId -> [{ fid, start }]
  const byChannel = new Map();
  for (const [fid, chSet] of result) {
    for (const chId of chSet) {
      if (!byChannel.has(chId)) byChannel.set(chId, []);
      byChannel.get(chId).push({ fid, start: startById.get(fid) });
    }
  }

  const drop = new Set(); // `${fid}|${chId}`
  for (const [chId, list] of byChannel) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length - 1; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].start - list[i].start >= MATCH_LEN_MS) break;
        const a = list[i], b = list[j];
        const aOk = epgConfirmed(a.fid, chId);
        const bOk = epgConfirmed(b.fid, chId);
        // An EPG-confirmed side wins the slot outright; with neither
        // confirmed there's no way to tell which is real, so both go.
        if (aOk && !bOk) drop.add(`${b.fid}|${chId}`);
        else if (bOk && !aOk) drop.add(`${a.fid}|${chId}`);
        else if (!aOk && !bOk) { drop.add(`${a.fid}|${chId}`); drop.add(`${b.fid}|${chId}`); }
      }
    }
  }

  // Check 2: the EPG on that channel, at that time, names a different
  // fixture we track. Only meaningful where the EPG actually carries team
  // names -- silent (and harmless) where it doesn't.
  for (const [fid, chSet] of result) {
    for (const chId of chSet) {
      if (epgConfirmed(fid, chId)) continue; // our own EPG backs it, keep
      if (epgClaimsOther(fid, chId)) drop.add(`${fid}|${chId}`);
    }
  }

  for (const [fid, chSet] of result) {
    for (const chId of [...chSet]) if (drop.has(`${fid}|${chId}`)) chSet.delete(chId);
    if (!chSet.size) result.delete(fid);
  }
  return result;
}

/**
 * Все `tvg-id` каналов этой страны, чьё имя совпадает с именем станции.
 * ВСЕ, а не первый попавшийся: одно имя станции часто накрывает несколько
 * разных id — как правило это варианты качества одного канала («Match!
 * Football 1» → Матч! Футбол 1 FHD / HD / HD Double / SD), на живых данных
 * так у 58 заявок из 321. Здесь стоял `find()`, и тогда выбор качества
 * определялся порядком каналов в плейлисте: у текущего провайдера они
 * перечислены по убыванию, так что случайно бралось лучшее — но логики за
 * этим не было, и другой плейлист молча отдавал бы SD или зеркало Double.
 * Заодно это ровно то же поведение, что у поиска по заголовкам EPG: тот
 * всегда возвращает все каналы, на которых нашёл матч.
 *
 * Совпадение требуется ТОЧНОЕ по токенам (см. findBroadcasters ниже) —
 * именно оно, а не что-либо ещё, не пускает сюда потоковые сервисы вроде
 * «DAZN.com (FR)» и «Sky Sports+ app», которых в ответе больше трети.
 */
function matchingChannelIds(stationName, countryChannels) {
  return matchingIds(tokens(stationName), prepareChannels(countryChannels));
}

/**
 * Каналы страны с заранее посчитанными токенами имени.
 *
 * Считать их один раз на страну, а не заново на каждое имя станции, —
 * разница принципиальная: станций в ответе FotMob около двух тысяч, каналов
 * в стране до тысячи, и наивный вариант делал два миллиона токенизаций
 * одной и той же тысячи имён. На живых данных это 980 мс в главном потоке
 * и 26 секунд в рабочем (там всё то же самое, но без прогретого JIT и с
 * куда большим давлением на сборщик мусора).
 */
function prepareChannels(countryChannels) {
  return countryChannels
    .filter((c) => c.id)
    .map((c) => ({ id: c.id, tokens: tokens(c.name) }));
}

function matchingIds(stationTokens, prepared) {
  const ids = new Set();
  for (const c of prepared) {
    if (similarityTokens(stationTokens, c.tokens) === 100) ids.add(c.id);
  }
  return ids;
}

/**
 * Matches FotMob's own fixture ids directly against `guide.json`'s (both
 * come from the same source, no fuzzy team-name matching needed at all --
 * that's the whole point over the EPG-title path). The only fuzzy step left
 * is the last one: FotMob's station name ("Sky Sports Main Event") against
 * our playlist's channel name ("UK: Sky Sports Main Event UHD"), scoped to
 * channels already known to be from that same country (`channel.country`,
 * set in playlist.js from the same `UK:`-style prefix FotMob's own
 * `countryCode` uses) -- structurally can't confuse e.g. UK Sky Sports with
 * unrelated DE/IT/NZ broadcasters of the same global brand, unlike a
 * name-only cross-country search would (see CLAUDE.md, "Sky Sports UK").
 *
 * Requires an EXACT token-content match (`similarity() === 100`), not the
 * fuzzy threshold used for team names -- caught live: FotMob's plain "Sky
 * Sports UHD" (no channel number) scored 88 against the wrong real channel
 * ("Sky Sports News HD", both reduced to just {sky, sports} once "UHD" is
 * stripped as a generic quality marker) instead of correctly finding no
 * match at all. This source is a bonus on top of the EPG-title path, not a
 * replacement for it, so losing a few ambiguous cases to stay exact-only
 * costs nothing -- the existing pipeline still covers them.
 *
 * Whatever survives that then goes through `dropUnsound()` above, which is
 * where this source's own unreliability gets filtered out.
 *
 * @param fixtures our own fixtures, needs .id and .start
 * @param channels playlist channels, needs .id, .name, .country
 * @param epgConfirmed (fixtureId, channelId) => bool -- did the EPG-title
 *        path independently find this same pairing? Used to break ties.
 * @param epgClaimsOther (fixtureId, channelId) => bool -- does the EPG show
 *        some *other* tracked fixture on that channel at that time?
 * @returns Map<fixtureId, Set<channelId>>
 */
/**
 * СЕТЕВАЯ половина. Выполняется в main-процессе — `tvlistings` идёт через
 * `net.fetch` стека Chromium, которого в рабочем потоке нет.
 *
 * Возвращает только имена станций, а не сырой ответ: сырьё это ~40 стран по
 * 300 КБ, и тащить его через границу процессов незачем — дальше нужны лишь
 * названия вещателей по нашим матчам.
 *
 * @returns Map<countryCode, Map<fixtureId, string[]>>
 */
async function collectStations(fixtureIds, countries, onProgress = () => {}) {
  const wanted = new Set(fixtureIds.map(String));
  const byCountry = new Map();

  for (let i = 0; i < countries.length; i += BATCH_SIZE) {
    const batch = countries.slice(i, i + BATCH_SIZE);
    onProgress(`Вещатели: ${batch.join(', ')}`);
    const listingsBatch = await Promise.all(batch.map(async (country) => {
      try {
        return await fetchListings(country);
      } catch {
        return null; // one country failing (network, FotMob doesn't cover it) doesn't sink the rest
      }
    }));

    for (let bi = 0; bi < batch.length; bi++) {
      const listings = listingsBatch[bi];
      if (!listings) continue;
      const perFixture = new Map();
      for (const [fid, entries] of Object.entries(listings)) {
        if (!wanted.has(fid)) continue;
        const names = [];
        for (const e of entries) {
          const name = e.station?.name || e.station?.callSign;
          if (name) names.push(name);
        }
        if (names.length) perFixture.set(fid, names);
      }
      if (perFixture.size) byCountry.set(batch[bi], perFixture);
    }
  }
  return byCountry;
}

/**
 * ЧИСТАЯ половина. Выполняется в рабочем потоке рядом с разобранным EPG —
 * фильтры в `dropUnsound()` спрашивают именно у него, что шло на канале.
 *
 * @param stationsByCountry результат collectStations()
 * @param channels каналы плейлиста (нужны .id, .name, .country)
 * @param fixtures наши фикстуры — нужны, чтобы вернуть id в исходном типе
 * @returns Map<fixtureId, Set<channelId>> — до отсева, «сырые» заявки
 */
function claimsFromStations(stationsByCountry, channels, fixtures) {
  const byCountry = new Map();
  for (const c of channels) {
    if (!c.country) continue;
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }
  // Ключи ответа FotMob — строки, а id фикстуры у нас число. Без этой
  // таблицы ключи разъехались бы по типу и dropUnsound() ниже не нашёл бы
  // ни одного матча по своему `startById` — молча, без единой ошибки.
  const realId = new Map(fixtures.map((f) => [String(f.id), f.id]));

  const claims = new Map();
  for (const [country, perFixture] of stationsByCountry) {
    const countryChannels = byCountry.get(country);
    if (!countryChannels) continue;
    // Токены имён каналов — один раз на страну, а не на каждое имя станции.
    const prepared = prepareChannels(countryChannels);
    for (const [key, names] of perFixture) {
      const fid = realId.get(key);
      if (fid === undefined) continue;
      for (const name of names) {
        for (const id of matchingIds(tokens(name), prepared)) {
          if (!claims.has(fid)) claims.set(fid, new Set());
          claims.get(fid).add(id);
        }
      }
    }
  }
  return claims;
}

module.exports = { collectStations, claimsFromStations, dropUnsound, matchingChannelIds };
