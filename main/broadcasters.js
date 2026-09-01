'use strict';
const { tokens, similarityTokens } = require('./normalize');
const { fetchJson, BATCH_SIZE } = require('./net');

/**
 * Собственные данные FotMob «где смотреть», по одной стране за запрос.
 * Найдено живьём: параметр `matchId` этот эндпоинт игнорирует полностью
 * (проверено на трёх разных id — побайтово одинаковые ответы), меняет
 * результат только `countryCode`, так что фиктивного id хватает на все
 * вызовы. Ответ — плоская карта `{ [matchId]: [{ station: {name} }] }` по
 * всем матчам, что FotMob знает для этой страны прямо сейчас.
 */
async function fetchListings(countryCode) {
  const url = `https://www.fotmob.com/api/data/tvlistings?matchId=1&countryCode=${countryCode}`;
  return fetchJson(url, `tvlistings ${countryCode}`);
}

// Свисток до финального, с запасом. Нужен только чтобы решить, пересекаются
// ли две заявки на один канал, так что ошибаться в большую сторону безопасно.
const MATCH_LEN_MS = 105 * 60 * 1000;

/**
 * Каналы страны с заранее посчитанными токенами имени. Считать их один раз
 * на страну, а не заново на каждое имя станции: станций в ответе около двух
 * тысяч, каналов в стране до тысячи, и наивный вариант делал два миллиона
 * токенизаций одной и той же тысячи имён. Замерено: 980 -> 116 мс.
 */
function prepareChannels(countryChannels) {
  return countryChannels
    .filter((c) => c.id)
    .map((c) => ({ id: c.id, tokens: tokens(c.name) }));
}

/**
 * Все tvg-id, чьё имя совпадает с именем станции. ВСЕ, а не первый: одно имя
 * станции часто накрывает несколько id — как правило варианты качества одного
 * канала («Match! Football 1» -> Матч! Футбол 1 FHD / HD / SD). Здесь стоял
 * `find()`, и тогда выбор качества определялся порядком каналов в плейлисте.
 *
 * Совпадение требуется ТОЧНОЕ (`similarityTokens() === 100`), а не по порогу
 * 78, как у команд: источник бонусный, потерять неоднозначный случай дешевле,
 * чем привязать чужой канал. Именно точность не пускает сюда потоковые
 * сервисы вроде «DAZN.com (FR)», которых в ответе больше трети, и она же
 * поймала живьём «Sky Sports UHD», набиравшее 88 против «Sky Sports News HD».
 */
function matchingIds(stationTokens, prepared) {
  const ids = new Set();
  for (const c of prepared) {
    if (similarityTokens(stationTokens, c.tokens) === 100) ids.add(c.id);
  }
  return ids;
}

/**
 * СЕТЕВАЯ половина. Возвращает только имена станций, а не сырой ответ: сырьё
 * это ~40 стран по 300 КБ, тащить его дальше незачем.
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
        return null; // одна отвалившаяся страна не топит остальные
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
 * ЧИСТАЯ половина: имена станций -> заявки на каналы, с уликой.
 *
 * Страна не выводится из текста, а задаётся самим запросом — это структурно
 * исключает путаницу между Sky UK, Sky DE и Sky IT, которую поиск только по
 * имени устроил бы неизбежно.
 *
 * @returns Map<fixtureId, Map<channelId, { station, country }>>
 */
function claimsFromStations(stationsByCountry, channels, fixtures) {
  const byCountry = new Map();
  for (const c of channels) {
    if (!c.country) continue;
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }
  // Ключи ответа FotMob и наши id матчей — и то и другое строки (проверено у
  // источника). Таблица не переводит тип, а отбрасывает заявки на матчи не из
  // нашего списка: у такого id нет `start`, и вся арифметика по времени в
  // dropUnsound() считалась бы на NaN. Заодно страхует стык, если FotMob
  // когда-нибудь сменит тип на одной из сторон.
  const realId = new Map(fixtures.map((f) => [String(f.id), f.id]));

  const claims = new Map();
  for (const [country, perFixture] of stationsByCountry) {
    const countryChannels = byCountry.get(country);
    if (!countryChannels) continue;
    const prepared = prepareChannels(countryChannels);
    for (const [key, names] of perFixture) {
      const fid = realId.get(key);
      if (fid === undefined) continue;
      for (const name of names) {
        for (const id of matchingIds(tokens(name), prepared)) {
          if (!claims.has(fid)) claims.set(fid, new Map());
          claims.get(fid).set(id, { station: name, country });
        }
      }
    }
  }
  return claims;
}

/**
 * Выбрасывает заявки, про которые можно ПОКАЗАТЬ, что источник ошибся.
 *
 * Источник отвечает на уровне ПРАВООБЛАДАТЕЛЯ, а не «какой канал в какую
 * минуту» — это его главное свойство, и из него всё остальное. Он спокойно
 * называет один канал сразу на пять матчей, два из которых идут
 * одновременно; живой аудит дал 21 ложную привязку из 242.
 *
 * Две чисто локальные проверки, без единого нового запроса:
 *   1. Один канал на два пересекающихся по времени матча — физически
 *      невозможно, и если EPG независимо не подтвердил один из них, доверять
 *      нельзя ни одному, выбывают оба.
 *   2. EPG показывает на этом канале в это время ДРУГОЙ отслеживаемый матч —
 *      прямое противоречие.
 *
 * Честная оговорка: они умеют опровергать, но не подтверждать. Там, где EPG
 * пуст — а это ровно случай Sky Sports UK, ради которого источник и
 * добавлялся, — проверить нечем.
 */
function dropUnsound(claims, fixtures, epgConfirmed, epgClaimsOther) {
  const startById = new Map(fixtures.map((f) => [f.id, f.start]));

  const byChannel = new Map();
  for (const [fid, chMap] of claims) {
    for (const chId of chMap.keys()) {
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
        // Подтверждённый EPG выигрывает слот; если не подтверждён ни один,
        // понять, какой настоящий, нечем — выбывают оба.
        if (aOk && !bOk) drop.add(`${b.fid}|${chId}`);
        else if (bOk && !aOk) drop.add(`${a.fid}|${chId}`);
        else if (!aOk && !bOk) { drop.add(`${a.fid}|${chId}`); drop.add(`${b.fid}|${chId}`); }
      }
    }
  }

  for (const [fid, chMap] of claims) {
    for (const chId of chMap.keys()) {
      if (epgConfirmed(fid, chId)) continue; // своё подтверждение сильнее
      if (epgClaimsOther(fid, chId)) drop.add(`${fid}|${chId}`);
    }
  }

  for (const [fid, chMap] of claims) {
    for (const chId of [...chMap.keys()]) if (drop.has(`${fid}|${chId}`)) chMap.delete(chId);
    if (!chMap.size) claims.delete(fid);
  }
  return claims;
}

module.exports = { collectStations, claimsFromStations, dropUnsound, prepareChannels, matchingIds };
