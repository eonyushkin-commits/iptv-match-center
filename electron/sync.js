'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const store = require('./store');
const fotmob = require('./fotmob');
const broadcasters = require('./broadcasters');
const playlist = require('./playlist');

const DAYS_BACK = 1;
const DAYS_FORWARD = 6;

// Столько запросов к FotMob одновременно в лёгком обновлении счёта — та же
// величина, что в broadcasters.js, по той же причине.
const SCORE_BATCH_SIZE = 8;

/**
 * Прогоняет тяжёлый этап в рабочем потоке и возвращает его результат.
 *
 * Смысл ровно один: разбор фида и сопоставление — это несколько секунд
 * сплошной синхронной работы, а main-процесс обслуживает ввод и IPC, и пока
 * он занят, окно не отвечает. В потоке эта работа никому не мешает, а
 * `programmes()` и `findBroadcastChannels()` остаются чистыми и синхронными,
 * без уступок event loop'у в сигнатурах.
 *
 * Бонусом память: 200-мегабайтный буфер фида и разобранные передачи живут в
 * потоке и возвращаются ОС сразу при его завершении, а не ждут сборки мусора
 * в главном процессе.
 */
function runStageInWorker(input, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'sync-worker.js'), { workerData: input });
    let settled = false;
    // terminate() дожидаемся до того, как отдать результат: изолят потока
    // держит 200-мегабайтный буфер фида и разобранные передачи, и пока он
    // жив, эта память числится за процессом. Без ожидания синк «заканчивался»
    // с вдвое большим потреблением, чем нужно.
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
    worker.on('exit', (code) => {
      // Штатный выход после terminate() приходит уже после settled — важен
      // только случай, когда поток умер, ничего не сообщив.
      finish(reject, new Error(`рабочий поток синхронизации завершился с кодом ${code}`));
    });
  });
}

/**
 * @param onProgress (text) => void
 * @returns { generatedAt, channelCount, stats, events: [...] } — события
 *          отсортированы по времени начала, рендерер на это рассчитывает.
 */
async function run(config, onProgress = () => {}) {
  const { channels, epgUrl } = await playlist.load(config.playlistPath);
  const url = config.epgUrl || epgUrl;
  if (!url) throw new Error('EPG-фид не найден: нет url-tvg в плейлисте и epgUrl в конфиге');

  onProgress('Скачиваю расписание турниров…');
  const fixtures = await fotmob.fixtures(DAYS_BACK, DAYS_FORWARD, onProgress, config.disabledCompetitions);

  // Only what's live or ahead — past results aren't what this app is for.
  // Считается до загрузки EPG: время начала этих матчей нужно уже разбору
  // фида, чтобы не тащить в память передачи, в которые никто не заглянет.
  const upcoming = fixtures.filter((f) => f.status !== 'finished');

  // Сетевая половина источника «где смотреть» — единственное, что от него
  // остаётся в main: `tvlistings` идёт через net.fetch стека Chromium,
  // которого в рабочем потоке нет. Отсев ложных заявок делается уже там,
  // рядом с разобранным EPG — фильтрам нужно знать, что реально шло на
  // канале.
  //
  // Сеть здесь идёт ДО запуска потока — то есть последовательно, а не
  // параллельно. Параллельный вариант пробовали и откатили: если станции
  // приходят потоку отдельным сообщением уже после старта, следующий за
  // ожиданием шаг замедляется в двадцать раз (1.1 с → 20–31 с, воспроизво-
  // дится устойчиво и растёт с задержкой). Причину найти не удалось: та же
  // функция на тех же данных в главном потоке отрабатывает за 116 мс, и
  // пауза там ни на что не влияет. Экономия была бы только на холодном
  // старте, а цена — непонятный двадцатикратный провал, так что не стоит.
  onProgress('Спрашиваю вещателей…');
  let stationsByCountry = new Map();
  try {
    const countries = [...new Set(channels.map((c) => c.country).filter(Boolean))];
    stationsByCountry = await broadcasters.collectStations(upcoming.map((f) => f.id), countries, onProgress);
  } catch (err) {
    // Один отвалившийся источник не должен ронять весь синк — сетка
    // соберётся по одному лишь поиску в заголовках EPG.
    onProgress(`Вещатели FotMob недоступны: ${err.message}`);
  }

  const { epgByFixture, extraBroadcasts, stats } = await runStageInWorker({
    epgUrl: url,
    cacheRoot: store.root,
    channels,
    fixtures: upcoming,
    stationsByCountry,
  }, onProgress);

  // Multiple playlist entries can share one tvg-id (quality variants), so
  // every broadcast card lists all of them as stream options.
  const byTvgId = new Map();
  for (const ch of channels) {
    if (!ch.id) continue;
    if (!byTvgId.has(ch.id)) byTvgId.set(ch.id, []);
    byTvgId.get(ch.id).push(ch);
  }
  for (const list of byTvgId.values()) list.sort((x, y) => y.quality - x.quality);

  let broadcastCount = 0;
  const allEvents = upcoming.map((f, i) => {
    const epgIds = epgByFixture.get(f.id) || new Set();
    const extraIds = extraBroadcasts.get(f.id) || [];
    const channelIds = [...new Set([...epgIds, ...extraIds])];
    const broadcasts = channelIds.map((channelId) => {
      const streams = byTvgId.get(channelId) || [];
      broadcastCount++;
      return {
        channelId,
        name: streams[0]?.name || channelId,
        country: streams[0]?.country || null,
        // Только то, что рендерер действительно читает. Здесь писались ещё
        // `id`, `logo` и `quality`: первый — побайтово тот же tvg-id, что
        // уже лежит рядом в `channelId` (проверено на живых данных, 245 из
        // 245 совпадений), второй нигде не выводится, третий нужен лишь для
        // сортировки строкой выше, а её результат и так закреплён порядком
        // элементов. Вместе это 14% размера guide.json впустую.
        streams: streams.map((s) => ({ name: s.name, url: s.url })),
      };
    });

    return {
      id: f.id || `${f.start}_${i}`,
      sport: 'football',
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
      venue: f.venue,
      broadcasts,
    };
  });

  // Плоский список, отсортированный по времени. Здесь строилось дерево
  // «дата -> турнир -> события», но рендерер тут же расплющивал его обратно
  // (лента идёт сплошным списком, заголовков дня и турнира в интерфейсе нет,
  // название турнира берётся из самого события), а refreshScores() был
  // вынужден обходить и переупаковывать все три уровня.
  const events = allEvents
    .filter((e) => e.broadcasts.length > 0)
    .sort((a, b) => a.start - b.start);

  const guide = {
    generatedAt: Date.now(),
    channelCount: channels.length,
    stats: {
      channels: stats.channels,
      programmes: stats.programmes,
      fixtures: fixtures.length,
      events: events.length,
      broadcasts: broadcastCount,
    },
    events,
  };
  store.writeJson(path.join(store.root, 'guide.json'), guide);
  return guide;
}

/**
 * Lightweight companion to `run()` — refreshes status/score/clock on
 * events already in `guide` (mutated in place) without re-fetching FotMob's
 * competition lists or redoing EPG channel matching. Only touches matches
 * that have actually kicked off and aren't confirmed finished yet — a
 * `notstarted` match needs no network call at all, its `start` timestamp
 * already says everything there is to say until kickoff. This keeps the
 * request count naturally proportional to "how many matches are live or
 * just wrapped up" (typically single digits), not the full ~100+ card
 * count, so it's cheap enough to run every couple of minutes — see
 * CLAUDE.md for the full split between this and `run()`.
 */
async function refreshScores(guide) {
  const now = Date.now();
  const targets = guide.events.filter((e) => e.start <= now && e.status !== 'finished');
  if (!targets.length) return guide;

  // Кусками, а не все разом: обычно живых матчей единицы, но в субботний
  // вечер их бывает и два десятка, и это тот же недокументированный хост,
  // ради которого в broadcasters.js уже введён батчинг — держать здесь
  // безлимитный Promise.all было непоследовательно.
  for (let i = 0; i < targets.length; i += SCORE_BATCH_SIZE) {
    await Promise.all(targets.slice(i, i + SCORE_BATCH_SIZE).map(async (e) => {
      const fresh = await fotmob.matchStatus(e.id);
      if (!fresh) return;
      e.status = fresh.status;
      e.homeScore = fresh.homeScore;
      e.awayScore = fresh.awayScore;
      e.clock = fresh.clock;
    }));
  }

  // Same "only live or ahead" rule as run() — a match that just finished
  // drops off here instead of waiting for the next full sync.
  guide.events = guide.events.filter((e) => e.status !== 'finished');
  guide.stats.events = guide.events.length;
  guide.stats.broadcasts = guide.events.reduce((n, e) => n + e.broadcasts.length, 0);

  store.writeJson(path.join(store.root, 'guide.json'), guide);
  return guide;
}

module.exports = { run, refreshScores };
