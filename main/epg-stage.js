'use strict';
const store = require('./store');
const epgIndex = require('./epg/index');
const feed = require('./epg/feed');
const link = require('./link');
const teams = require('./teams');
const broadcasters = require('./broadcasters');

/**
 * Тяжёлая половина синхронизации: разобрать фид (если он сменился),
 * сопоставить матчи (те, что изменились) и отсеять заявки вещателей.
 *
 * Вынесена отдельной ЧИСТОЙ функцией, а не написана прямо в воркере: её можно
 * вызвать и проверить напрямую, без потоков, а сам воркер остаётся десятком
 * строк передачи сообщений, где ломаться нечему.
 *
 * Почему это вообще в потоке. Замерено на живом фиде: разбор 213 МБ XML —
 * 2465 мс сплошной синхронной работы, и ещё около секунды уходит на
 * сопоставление, когда матчи новые. Окно рисует свой процесс, но ввод и IPC
 * обслуживает main, так что всё это время приложение выглядит зависшим.
 *
 * Отличие от предыдущего проекта не в наличии потока, а в том, СКОЛЬКО он
 * делает. Там этот этап целиком повторялся на каждом синке. Здесь разбор
 * случается раз на скачанный фид (шесть часов), сопоставление — только для
 * матчей, которые новые или переехали; на установившемся синке обе тяжёлые
 * части не выполняются вовсе, и поток лишь читает готовый индекс.
 *
 * Бонусом память: 213-мегабайтный буфер фида живёт и умирает внутри потока.
 *
 * @param input.cachedLinks сохранённое из links.json целиком —
 *        { feedVersion, channelsKey, byFixture } либо null. Именно целиком, а
 *        не одни лишь связи: годность проверяется ЗДЕСЬ, потому что только
 *        здесь известна версия фида после возможной перекачки.
 * @returns { links, extraBroadcasts, stats }
 */
async function run(input, onProgress = () => {}) {
  const { epgUrl, cacheRoot, channels, fixtures, cachedLinks, stationsByCountry, aliases } = input;
  store.setRoot(cacheRoot);

  const { rows, stats: epgStats } = await epgIndex.get(epgUrl, channels, onProgress);
  const feedVersion = feed.cachedVersion(epgUrl) ?? 'unknown';
  const channelsKey = epgIndex.channelsKey(new Set(channels.map((c) => c.id).filter(Boolean)));

  // В память разворачивается только то, во что сопоставление заглянет: окна
  // ±90 минут вокруг свистков. Сам индекс при этом остаётся полным и потому
  // переживает смену расписания.
  const programmes = epgIndex.window(rows, fixtures.map((f) => f.start), link.WINDOW_MS);

  // Формы имени — по разу на матч: ниже они нужны ещё и перекрёстной проверке,
  // которая иначе пересобирала бы их на каждую пару (заявка, матч).
  const formsById = new Map(fixtures.map((f) => [f.id, {
    home: teams.formsFor(aliases, f.home, f.homeShort),
    away: teams.formsFor(aliases, f.away, f.awayShort),
  }]));

  const candidates = new Map();
  const links = {};
  let matched = 0;
  let reusedLinks = 0;

  // Связи годятся, только если с тех пор не сменились НИ фид, НИ набор
  // каналов: и то и другое целиком определяет результат сопоставления.
  //
  // Проверка была потеряна при переносе этапа в рабочий поток, и это стоило
  // живого сбоя: пользователь сменил источник, фид перекачался, индекс
  // построился заново — а связи взялись готовыми от прежнего фида. Все
  // трансляции в ленте стали «только FotMob», потому что переиспользовался
  // мусор. Внешне это выглядело как «EPG перестал работать», хотя
  // сопоставление было исправно и с нуля находило 51 связь против 2 в кэше.
  const sameFeed = cachedLinks
    && cachedLinks.feedVersion === feedVersion
    && cachedLinks.channelsKey === channelsKey;
  const previous = sameFeed ? (cachedLinks.byFixture || {}) : {};

  for (const f of fixtures) {
    const prev = previous[String(f.id)];
    // Годится, пока у матча не уехало время: перенесённый матч надо
    // сопоставлять заново, его окно сдвинулось.
    if (prev && prev.start === f.start) {
      links[String(f.id)] = prev;
      reusedLinks++;
      continue;
    }
    links[String(f.id)] = { start: f.start, epg: link.fromEpg(programmes, f, formsById.get(f.id), candidates) };
    matched++;
    if (matched % 25 === 0) onProgress(`Сопоставляю с каналами… ${matched}`);
  }

  const epgIdsById = new Map(Object.entries(links).map(([fid, v]) => [fid, new Set(v.epg.map((e) => e.channelId))]));

  // --- заявки вещателей ----------------------------------------------------
  // Отсев живёт здесь, рядом с разобранным EPG: фильтры спрашивают именно у
  // него, что реально шло на канале в это время.
  let claims = new Map();
  if (stationsByCountry && stationsByCountry.size) {
    claims = broadcasters.claimsFromStations(stationsByCountry, channels, fixtures);

    const progsByChannel = new Map();
    for (const p of programmes) {
      if (!progsByChannel.has(p.channelId)) progsByChannel.set(p.channelId, []);
      progsByChannel.get(p.channelId).push(p);
    }
    const byId = new Map(fixtures.map((f) => [f.id, f]));

    broadcasters.dropUnsound(
      claims,
      fixtures,
      (fid, chId) => epgIdsById.get(String(fid))?.has(chId) || false,
      (fid, chId) => {
        const f = byId.get(fid);
        if (!f) return false;
        const lo = f.start - link.WINDOW_MS;
        const hi = f.start + link.WINDOW_MS;
        const progs = (progsByChannel.get(chId) || []).filter((p) => p.start >= lo && p.start <= hi);
        if (!progs.length) return false;
        // Показывает ли EPG на этом канале ДРУГОЙ наш матч — та же планка
        // «названы обе команды», что и в основном поиске. Окно берётся вокруг
        // свистка ЭТОГО матча: вопрос в том, что шло здесь и сейчас.
        const other = fixtures.some((o) => o.id !== fid
          && link.fromEpg(progs, { ...o, start: f.start }, formsById.get(o.id)).length > 0);
        if (other) return true;
        // Или вовсе другой вид спорта в момент свистка. `stop` — настоящий
        // конец из фида, поэтому передача, просто ПРЕДШЕСТВУЮЩАЯ свистку,
        // противоречием не считается, а начавшаяся часом раньше и идущая
        // насквозь — считается.
        return progs.some((p) => {
          if (!link.isOtherSport(p.title)) return false;
          const ends = p.stop ?? (p.start + link.WINDOW_MS);
          return (p.start <= f.start && ends > f.start)
            || (p.start > f.start && p.start < f.start + link.WINDOW_MS);
        });
      },
    );
  }

  return {
    links,
    feedVersion,
    channelsKey,
    // Map переносится структурным клонированием как есть, с ключами любого
    // типа; обычный объект привёл бы их к строкам. Сегодня id матчей у FotMob
    // строковые (проверено у источника), так что объект сработал бы тоже, —
    // Map оставлен ради независимости от типа: смени источник его на одной из
    // сторон, объект молча схлопнул бы ключи, и ни один матч не нашёлся бы,
    // не выдав при этом ни единой ошибки.
    extraBroadcasts: claims,
    candidates,
    stats: { epgProgrammes: epgStats.total, indexReused: epgStats.reused, matched, reusedLinks },
  };
}

module.exports = { run };
