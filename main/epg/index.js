'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../store');
const feed = require('./feed');

const FORMAT = 1;

// ---------------------------------------------------------------------------
// Разбор XMLTV
// ---------------------------------------------------------------------------

// Порядок атрибутов различается между фидами и даже внутри одного, поэтому
// читаем по имени, никогда по позиции.
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Заголовки несут сырые XML-сущности («&#34;Эльче&#34;»). Не раскрыв их,
// получаем «34» отдельным токеном-цифрой, а сравнение имён жёстко отвергает
// пары с разным набором цифр — команда молча переставала находиться.
function decodeEntities(s) {
  return s.replace(/&(#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, _all, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

const tag = (s, name) => {
  const m = s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()) : '';
};

const TAG_OPEN = Buffer.from('<programme');
const TAG_CLOSE = Buffer.from('</programme>');
const CH_GT = 0x3e; // '>'
// Что может стоять сразу после имени тега: пробельное или сам '>'. Иначе
// `<programmes>` и прочее, начинающееся так же, принималось бы за наш тег.
const NAME_END = new Set([0x20, 0x09, 0x0a, 0x0d, CH_GT]);

/** «20260820184500 +0000» -> мс от эпохи. */
function parseTime(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  const offsetMin = tz ? (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) : 0;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offsetMin * 60000;
}

/**
 * Все передачи на каналах, которые есть в плейлисте, отсортированные по
 * началу. Без предфильтра «спортивный ли это канал»: та эвристика
 * (номер группы, потом слова в имени) откалибрована под одного провайдера и
 * при этом пропускает настоящие матчи на нейтральных каналах — сборную на
 * Первом, кубок Германии на ARD. Решает, матч это или нет, сопоставление
 * дальше по конвейеру.
 *
 * Без фильтра по окнам вокруг свистков — и это принципиально: индекс не
 * знает про матчи и потому переживает их изменение. Именно поэтому его
 * можно построить один раз на фид, а не заново на каждый синк.
 *
 * Разбор идёт по БАЙТАМ, а не по строке: фид бывает за 200 МБ, и из-за
 * кириллицы V8 держал бы строку по два байта на символ — четверть гигабайта,
 * живущая всё время разбора. По буферу в JS-строки превращаются только
 * мелкие куски: атрибуты открывающего тега и тело подошедших передач.
 *
 * @returns { rows, channelCount, total } — rows это компактные
 *   [channelId, start, stop, title], в таком же виде они и лягут на диск.
 */
function build(xmlSource, channelIds) {
  const buf = Buffer.isBuffer(xmlSource) ? xmlSource : Buffer.from(xmlSource, 'utf8');
  const known = channelIds instanceof Set ? channelIds : new Set(channelIds);
  const rows = [];
  let total = 0;
  let pos = 0;

  for (;;) {
    const open = buf.indexOf(TAG_OPEN, pos);
    if (open === -1) break;
    const attrEnd = buf.indexOf(CH_GT, open);
    if (attrEnd === -1) break;
    const bodyStart = attrEnd + 1;
    pos = bodyStart;

    if (!NAME_END.has(buf[open + TAG_OPEN.length])) continue;

    const attrs = buf.toString('utf8', open + TAG_OPEN.length, attrEnd);
    const channelId = attr(attrs, 'channel');
    if (!known.has(channelId)) continue;

    const start = parseTime(attr(attrs, 'start'));
    if (start == null) continue;
    total++;

    const close = buf.indexOf(TAG_CLOSE, bodyStart);
    if (close === -1) break;
    pos = close + TAG_CLOSE.length;
    const title = tag(buf.toString('utf8', bodyStart, close), 'title');
    if (!title) continue;

    // Конец передачи фид сообщает, и он нужен: «что реально шло на канале в
    // момент свистка» без настоящего конца не ответить. Угадывание
    // длительности пропускало волейбол, начавшийся за час до свистка и
    // шедший сквозь него, как «просто предыдущий слот». Часть фидов его не
    // даёт, поэтому null допустим.
    const stop = parseTime(attr(attrs, 'stop'));

    rows.push([channelId, start, stop ?? null, title]);
  }

  rows.sort((a, b) => a[1] - b[1]);
  return { rows, channelCount: known.size, total };
}

// ---------------------------------------------------------------------------
// Хранение и обращение
// ---------------------------------------------------------------------------

const key = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const indexPath = (url) => path.join(store.root, `epg-index-${key(url)}.json`);

/**
 * Выбрасывает индексы, оставшиеся от чужих фидов.
 *
 * Индекс годен только вместе со своим фидом (см. get(): без свежего файла
 * фида он не переиспользуется никогда), поэтому индекс, у которого фида уже
 * нет, — это просто мусор. А мусор здесь дорогой: 30+ МБ на каждый когда-то
 * использованный источник. Сам фид чистится в feed.js по TTL, но его прополка
 * ловит только `epg-<hash>.xml.gz` и про индексы не знает — так они и
 * копились бы вечно у всякого, кто хоть раз сменил провайдера. Ровно на этом
 * в предыдущем проекте накопилось 170 МБ от четырёх источников.
 */
function pruneIndexes(keep) {
  let names;
  try {
    names = fs.readdirSync(store.root);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.match(/^epg-index-([0-9a-f]+)\.json$/);
    if (!m) continue;
    const p = path.join(store.root, name);
    if (p === keep) continue;
    // Фид с тем же отпечатком ещё жив — значит источник просто не выбран
    // сейчас, но к нему могут вернуться; индекс оставляем.
    if (fs.existsSync(path.join(store.root, `epg-${m[1]}.xml.gz`))) continue;
    try { fs.unlinkSync(p); } catch { /* исчез сам или занят — не наша забота */ }
  }
}

/** Отпечаток набора каналов: сменился плейлист — индекс надо строить заново,
 * потому что отбор передач шёл именно по нему. */
const channelsKey = (channelIds) => key([...channelIds].sort().join('\n'));

/**
 * Индекс для этого фида: с диска, если он всё ещё описывает тот же фид и тот
 * же набор каналов, иначе строится заново (и тогда фид действительно
 * качается и разбирается).
 *
 * Это и есть та самая инкрементальность: в предыдущем проекте 213 МБ XML
 * разбирались на КАЖДЫЙ синк — шесть раз за один TTL фида, ради побайтово
 * одного и того же результата. Столько работы, что её пришлось уносить в
 * отдельный поток, чтобы не морозить окно.
 *
 * @returns { programmes, stats: { channels, total, reused } }
 *   programmes — [{ channelId, start, stop, title }], отсортированы по началу.
 */
async function get(epgUrl, channels, onProgress = () => {}) {
  const ids = new Set(channels.map((c) => c.id).filter(Boolean));
  const chKey = channelsKey(ids);
  const file = indexPath(epgUrl);
  // На каждом заходе, а не только после перестроения: пока текущий индекс
  // свежий, сюда ниже мы и не дойдём, а чужие остатки лежали бы до
  // ближайшего обновления фида.
  pruneIndexes(file);
  const version = feed.cachedVersion(epgUrl);

  if (version) {
    const cached = store.readJson(file, null);
    if (cached && cached.v === FORMAT && cached.feedVersion === version && cached.channelsKey === chKey) {
      onProgress('Беру разобранный EPG из индекса…');
      return { rows: cached.rows, stats: { channels: cached.channels, total: cached.total, reused: true } };
    }
  }

  onProgress('Скачиваю EPG…');
  const { xml, version: freshVersion } = await feed.load(epgUrl);
  onProgress('Разбираю фид…');
  const { rows, channelCount, total } = build(xml, ids);

  store.writeJson(file, {
    v: FORMAT,
    feedVersion: freshVersion,
    channelsKey: chKey,
    builtAt: Date.now(),
    channels: channelCount,
    total,
    rows,
  }, { pretty: false });

  return { rows, stats: { channels: channelCount, total, reused: false } };
}

const inflate = (r) => ({ channelId: r[0], start: r[1], stop: r[2], title: r[3] });

/** Склеенные, отсортированные окна ±`halfWidth` вокруг переданных свистков. */
function mergeWindows(kickoffs, halfWidth) {
  const sorted = [...kickoffs].filter(Number.isFinite).sort((a, b) => a - b);
  const merged = [];
  for (const k of sorted) {
    const lo = k - halfWidth;
    const hi = k + halfWidth;
    const last = merged[merged.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/**
 * Передачи, лежащие в окнах вокруг свистков, — уже объектами.
 *
 * Отбор по матчам живёт ЗДЕСЬ, а не в индексе, и это разделение существенно:
 * сам индекс остаётся годным при любой смене расписания (потому и строится
 * раз на фид), а в память разворачивается только то, во что сопоставление
 * действительно заглянет. На живых данных это 27% фида вместо 100% — иначе
 * 431 тысяча объектов держится в памяти впустую, ради 116 тысяч нужных.
 *
 * Строки отсортированы по началу, поэтому каждое окно — срез по бинарному
 * поиску, а не проход по всему массиву.
 */
function window(rows, kickoffs, halfWidth) {
  // Нет свистков — не «показать всё», а «смотреть не на что». Разница
  // существенная: если FotMob целиком отвалится, список матчей окажется
  // пустым, и трактовка «без фильтра» развернула бы в память весь фид
  // (431 тысяча объектов) ради нуля матчей.
  if (!kickoffs.length) return [];
  const out = [];
  for (const [lo, hi] of mergeWindows(kickoffs, halfWidth)) {
    let i = firstAtOrAfterRow(rows, lo);
    for (; i < rows.length && rows[i][1] <= hi; i++) out.push(inflate(rows[i]));
  }
  // Окна склеены и идут по возрастанию, так что порядок уже верный; сортировка
  // тут была бы работой впустую на сотне тысяч элементов.
  return out;
}

function firstAtOrAfterRow(rows, ms) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][1] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Индекс первой передачи, начинающейся не раньше `ms`. Список отсортирован,
 * так что окно вокруг свистка — это срез, а не проход с головы. */
function firstAtOrAfter(programmes, ms) {
  let lo = 0;
  let hi = programmes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (programmes[mid].start < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

module.exports = {
  build, get, window, mergeWindows, firstAtOrAfter, channelsKey,
  indexPath, pruneIndexes, parseTime, attr, tag,
};
