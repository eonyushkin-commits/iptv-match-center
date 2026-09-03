'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const store = require('./store');
const fotmob = require('./fotmob');
const playlist = require('./playlist');
const teams = require('./teams');
const broadcasters = require('./broadcasters');
const { BATCH_SIZE } = require('./net');

const DAYS_BACK = 1;
const DAYS_FORWARD = 6;

// Заявки вещателей меняются медленно — они про права на показ, а не про
// минуту эфира. Перепрашивать сорок стран на каждый синк незачем.
const STATIONS_TTL_MS = 3 * 3600 * 1000;

// Версия 2, а не 1, и это не косметика. В 2.0.0 связи переиспользовались без
// проверки версии фида — и, что хуже, записывались обратно уже под ВЕРСИЕЙ
// НОВОГО фида. То есть негодный кэш «отмывался» и начинал выглядеть годным.
// Проверка, добавленная в 2.0.1, такой кэш отвергнуть не может: версии в нём
// совпадают честно. Живой случай: пользователь перебрал несколько EPG-фидов,
// один из них покрывал 24 канала вместо 3965, пустые связи от него отмылись и
// доехали до рабочего фида — в ленте не осталось ни одной трансляции из EPG.
//
// Смена номера формата выбрасывает такой кэш ровно один раз, при первом
// запуске новой версии. Дальше отмывать нечего: связи переиспользуются только
// при совпадении версии, значит записываются под той же, под которой считались.
const LINKS_FORMAT = 2;
// Версия формата сетки. Приложение носит то же имя, что и предшественник
// (1.4.8), а значит читает ТУ ЖЕ папку в %APPDATA% — и наткнётся на его
// guide.json, где у трансляции нет ни `sources`, ни `epg`. Рендерер на таком
// упал бы при первом же рисовании. Несовпадение версии считается отсутствием
// кэша: полный синк при запуске всё равно перезапишет файл.
const GUIDE_FORMAT = 2;
const linksPath = () => path.join(store.root, 'links.json');
const stationsPath = () => path.join(store.root, 'stations.json');
const guidePath = () => path.join(store.root, 'guide.json');

/**
 * Тяжёлый этап в рабочем потоке.
 *
 * Замерено на живом фиде: разбор 213 МБ XML — 2465 мс сплошной синхронной
 * работы, плюс около секунды на сопоставление, когда матчи новые. Окно рисует
 * свой процесс, но ввод и IPC обслуживает main, так что всё это время
 * приложение выглядит зависшим.
 *
 * Поток здесь по той же причине, что и в предыдущем проекте. Разница в том,
 * СКОЛЬКО он делает: там этап целиком повторялся каждый синк, здесь на
 * установившемся синке обе тяжёлые части не выполняются вовсе.
 */
function runStageInWorker(input, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'stage-worker.js'), { workerData: input });
    let settled = false;
    // terminate() дожидаемся до того, как отдать результат: изолят потока
    // держит буфер фида и разобранные передачи, и пока он жив, эта память
    // числится за процессом.
    const finish = async (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        await worker.terminate();
      } catch { /* поток уже мёртв — ровно то, чего мы и добивались */ }
      fn(value);
    };
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress(msg.text);
      else if (msg.type === 'done') finish(resolve, msg.result);
      else if (msg.type === 'error') finish(reject, new Error(msg.message));
    });
    worker.on('error', (err) => finish(reject, err));
    // Штатный выход после terminate() приходит уже после settled — важен
    // только случай, когда поток умер, ничего не сообщив.
    worker.on('exit', (code) => finish(reject, new Error(`рабочий поток завершился с кодом ${code}`)));
  });
}

/** Имена станций по странам, с TTL. */
async function stations(fixtureIds, countries, onProgress) {
  const saved = store.readJson(stationsPath(), null);
  if (saved && Date.now() - saved.at < STATIONS_TTL_MS) {
    onProgress('Вещатели: беру из кэша…');
    return new Map(saved.byCountry.map(([c, per]) => [c, new Map(per)]));
  }
  onProgress('Спрашиваю вещателей…');
  const byCountry = await broadcasters.collectStations(fixtureIds, countries, onProgress);
  store.writeJson(stationsPath(), {
    at: Date.now(),
    byCountry: [...byCountry].map(([c, per]) => [c, [...per]]),
  });
  return byCountry;
}

/**
 * Пересборка сетки — «полная» по смыслу, но не по работе: каждый шаг сперва
 * спрашивает, изменилось ли то, от чего он зависит.
 */
async function run(config, onProgress = () => {}) {
  const { channels, epgUrl: fromPlaylist } = await playlist.load(config.playlistPath);
  const epgUrl = config.epgUrl || fromPlaylist;
  if (!epgUrl) throw new Error('EPG-фид не найден: нет url-tvg в плейлисте и epgUrl в конфиге');

  teams.ensureFile();

  onProgress('Скачиваю расписание турниров…');
  const fixtures = (await fotmob.fixtures(DAYS_BACK, DAYS_FORWARD, onProgress, config.disabledCompetitions))
    // Только живое и предстоящее — прошлые результаты не то, ради чего это всё.
    .filter((f) => f.status !== 'finished');

  // Сеть вещателей идёт ДО потока, и это единственное место, где порядок
  // продиктован границей потоков, а не предметной областью: `tvlistings`
  // ходит через `net.fetch` стека Chromium, которого в потоке нет, а отсев
  // заявок обязан жить рядом с разобранным EPG — фильтрам нужно знать, что
  // реально шло на канале.
  let stationsByCountry = new Map();
  try {
    const countries = [...new Set(channels.map((c) => c.country).filter(Boolean))];
    stationsByCountry = await stations(fixtures.map((f) => f.id), countries, onProgress);
  } catch (err) {
    // Один отвалившийся источник не должен ронять весь синк — сетка соберётся
    // по одному лишь поиску в заголовках EPG.
    onProgress(`Вещатели недоступны: ${err.message}`);
  }

  // Сохранённое отдаём этапу ЦЕЛИКОМ, вместе с версией фида и отпечатком
  // каналов: годность проверяет он, потому что только он знает версию после
  // возможной перекачки. Отдать одни лишь связи, без версий, значит отдать их
  // без срока годности — на этом уже обожглись.
  const savedLinks = store.readJson(linksPath(), null);
  const { links, feedVersion, channelsKey, matcherKey, extraBroadcasts, candidates, stats: stageStats } =
    await runStageInWorker({
      epgUrl,
      cacheRoot: store.root,
      channels,
      fixtures,
      cachedLinks: savedLinks?.v === LINKS_FORMAT ? savedLinks : null,
      stationsByCountry,
      aliases: teams.load(),
    }, onProgress);

  store.writeJson(linksPath(), {
    v: LINKS_FORMAT, feedVersion, channelsKey, matcherKey, savedAt: Date.now(), byFixture: links,
  });
  teams.recordCandidates(candidates);

  // --- сборка сетки --------------------------------------------------------
  // Несколько записей плейлиста могут делить один tvg-id (варианты качества),
  // поэтому карточка канала перечисляет их все.
  const byTvgId = new Map();
  for (const ch of channels) {
    if (!ch.id) continue;
    if (!byTvgId.has(ch.id)) byTvgId.set(ch.id, []);
    byTvgId.get(ch.id).push(ch);
  }
  for (const list of byTvgId.values()) list.sort((x, y) => y.quality - x.quality);

  let broadcastCount = 0;
  const events = [];
  for (const f of fixtures) {
    const epgLinks = links[String(f.id)]?.epg || [];
    const claimed = extraBroadcasts.get(f.id) || new Map();

    // Здесь и живёт главное отличие модели: связь несёт своё происхождение,
    // а не растворяется в безымянном списке id каналов.
    const merged = new Map();
    for (const e of epgLinks) {
      merged.set(e.channelId, {
        channelId: e.channelId,
        sources: ['epg'],
        epg: { title: e.title, start: e.start, stop: e.stop, exact: e.exact },
        broadcaster: null,
      });
    }
    for (const [chId, ev] of claimed) {
      const existing = merged.get(chId);
      if (existing) {
        existing.sources.push('broadcaster');
        existing.broadcaster = ev;
      } else {
        merged.set(chId, { channelId: chId, sources: ['broadcaster'], epg: null, broadcaster: ev });
      }
    }

    const broadcasts = [...merged.values()].map((b) => {
      const streams = byTvgId.get(b.channelId) || [];
      broadcastCount++;
      return {
        ...b,
        name: streams[0]?.name || b.channelId,
        country: streams[0]?.country || null,
        streams: streams.map((s) => ({ name: s.name, url: s.url })),
      };
    });
    // Порядок — по надёжности, явно, а не по случайности сборки: подтверждено
    // обоими источниками, потом телепрограмма канала, потом голая заявка
    // правообладателя. Первое — единственное, что здесь вообще можно назвать
    // проверенным; последнее опровергнуть было нечем, а не подтверждено.
    const rank = (b) => (b.sources.length > 1 ? 0 : (b.epg ? 1 : 2));
    broadcasts.sort((a, b) => rank(a) - rank(b));

    if (!broadcasts.length) continue;
    events.push({
      id: f.id,
      tournament: f.competition,
      tournamentLogo: f.competitionLogo,
      tournamentColor: f.competitionColor,
      home: f.home,
      away: f.away,
      homeShort: f.homeShort,
      awayShort: f.awayShort,
      homeLogo: f.homeLogo,
      awayLogo: f.awayLogo,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
      start: f.start,
      status: f.status,
      clock: f.clock,
      broadcasts,
    });
  }
  events.sort((a, b) => a.start - b.start);

  const guide = {
    v: GUIDE_FORMAT,
    generatedAt: Date.now(),
    channelCount: channels.length,
    stats: { fixtures: fixtures.length, events: events.length, broadcasts: broadcastCount, ...stageStats },
    events,
  };
  store.writeJson(guidePath(), guide);
  return guide;
}

/**
 * Дешёвый спутник run(): освежает счёт, статус и минуту у матчей, которые уже
 * начались и ещё не завершены. Не трогает ни турниры списком, ни EPG. У
 * матча, который ещё не начался, нет ни одного сетевого запроса — его `start`
 * говорит всё, что нужно знать, до самого удара по мячу.
 */
async function refreshScores(guide) {
  const now = Date.now();
  const targets = guide.events.filter((e) => e.start <= now && e.status !== 'finished');
  if (!targets.length) return guide;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    await Promise.all(targets.slice(i, i + BATCH_SIZE).map(async (e) => {
      const fresh = await fotmob.matchStatus(e.id);
      if (!fresh) return;
      e.status = fresh.status;
      e.homeScore = fresh.homeScore;
      e.awayScore = fresh.awayScore;
      e.clock = fresh.clock;
    }));
  }

  // То же правило «только живое и предстоящее», что и в run(): завершившийся
  // матч уходит сразу, а не висит до следующего полного синка.
  guide.events = guide.events.filter((e) => e.status !== 'finished');
  guide.stats.events = guide.events.length;
  guide.stats.broadcasts = guide.events.reduce((n, e) => n + e.broadcasts.length, 0);
  store.writeJson(guidePath(), guide);
  return guide;
}

module.exports = { run, refreshScores, guidePath, linksPath, stationsPath, GUIDE_FORMAT };
