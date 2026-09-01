'use strict';

const el = (id) => document.getElementById(id);

let guide = null;
let filter = 'all';
let current = null; // { event, broadcast }

const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

function showDiag(message) {
  const diag = el('diag');
  diag.hidden = !message;
  diag.textContent = message || '';
}

// День в ЛОКАЛЬНОЙ зоне. Через toISOString() здесь была бы дата по UTC — при
// том что время на карточке рисуется через Intl, то есть локальное. У матча,
// начинающегося в 00:30 по Москве, UTC-дата вчерашняя, и ярлык выходил
// «Сегодня» вместо «Завтра»: задевало всё, что стартует после 21:00 UTC.
function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateBadge(startMs) {
  const day = localDay(new Date(startMs));
  const today = new Date();
  if (day === localDay(today)) return 'Сегодня';
  // setDate, а не +86400000: в сутках перехода на летнее время не 24 часа.
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day === localDay(tomorrow)) return 'Завтра';
  return DAY.format(new Date(startMs));
}

// Дольше этого матч от свистка не идёт. Статус последнего синка успевает
// устареть — это клиентская подстраховка, чтобы закончившийся матч не висел
// вечно с той минутой, на которой его застали.
const MATCH_MAX_MS = 150 * 60 * 1000;

function visibleEvents() {
  const cutoff = Date.now() - MATCH_MAX_MS;
  return guide.events.filter((e) => e.start > cutoff);
}

function crest(url, alt) {
  const img = document.createElement('img');
  img.className = 'crest';
  img.alt = alt;
  img.loading = 'lazy';
  img.addEventListener('error', () => { img.style.display = 'none'; });
  if (url) img.src = url;
  else img.style.display = 'none';
  return img;
}

/**
 * Откуда взялась эта связь — словами, для подсказки на чипе.
 *
 * Ради этого затевалась вся модель с происхождением. В предыдущем проекте
 * канал попадал в карточку безымянно, и на вопрос «почему он здесь» нельзя
 * было ответить, не прогнав сопоставление заново — что и пришлось делать
 * вживую, когда два канала показали не тот матч.
 */
function provenanceText(b) {
  const lines = [];
  if (b.epg) {
    const when = `${TIME.format(new Date(b.epg.start))}${b.epg.stop ? '–' + TIME.format(new Date(b.epg.stop)) : ''}`;
    lines.push(`В программе канала: «${b.epg.title}» (${when})`);
    if (!b.epg.exact) lines.push('Имя команды опознано неточно');
  }
  if (b.broadcaster) lines.push(`FotMob: права у «${b.broadcaster.station}» (${b.broadcaster.country})`);
  if (b.sources.length > 1) lines.push('Подтверждено обоими источниками');
  else if (!b.epg) lines.push('Телепрограмма канала это не подтверждает');
  lines.push('', ...b.streams.map((s) => s.name));
  return lines.join('\n');
}

function chipFor(event, broadcast) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  if (broadcast.sources.length > 1) chip.classList.add('is-confirmed');
  else if (!broadcast.epg) chip.classList.add('is-weak');

  const mark = document.createElement('span');
  mark.className = 'mark';
  // Двумя источниками подтверждено / только телепрограмма / только права.
  mark.textContent = broadcast.sources.length > 1 ? '✓' : (broadcast.epg ? '·' : '?');
  chip.append(mark, document.createTextNode(broadcast.name));

  chip.title = provenanceText(broadcast);
  chip.addEventListener('click', (e) => { e.stopPropagation(); play(event, broadcast); });
  return chip;
}

function teamsGrid(event) {
  const grid = document.createElement('div');
  grid.className = 'teams';
  const rows = [
    { name: event.homeShort || event.home, logo: event.homeLogo, score: event.homeScore },
    { name: event.awayShort || event.away, logo: event.awayLogo, score: event.awayScore },
  ];
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'team';
    row.append(crest(r.logo, r.name));
    const name = document.createElement('span');
    name.className = 'team-name';
    name.textContent = r.name;
    row.append(name);
    grid.append(row);
  }

  const side = document.createElement('div');
  side.className = 'side';
  if (event.status === 'notstarted') {
    side.classList.add('is-time');
    side.textContent = TIME.format(new Date(event.start));
  } else {
    for (const r of rows) {
      const s = document.createElement('span');
      s.textContent = r.score ?? 0;
      side.append(s);
    }
  }
  grid.append(side);
  return grid;
}

function matchCard(event) {
  const card = document.createElement('article');
  card.className = 'card';
  if (event.status === 'inprogress') card.classList.add('is-live');
  if (event.tournamentColor) card.style.setProperty('--accent', event.tournamentColor);

  const top = document.createElement('div');
  top.className = 'top';
  const league = document.createElement('div');
  league.className = 'league';
  if (event.tournamentLogo) league.append(crest(event.tournamentLogo, ''));
  const lname = document.createElement('span');
  lname.textContent = event.tournament;
  league.append(lname);
  top.append(league);

  const badge = document.createElement('span');
  if (event.status === 'inprogress') {
    badge.className = 'badge is-live';
    badge.textContent = event.clock ? `LIVE · ${event.clock}` : 'LIVE';
  } else {
    badge.className = 'badge';
    badge.textContent = dateBadge(event.start);
  }
  top.append(badge);
  card.append(top, teamsGrid(event));

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const b of event.broadcasts) chips.append(chipFor(event, b));
  card.append(chips);

  card.addEventListener('click', () => play(event, event.broadcasts[0]));
  return card;
}

async function play(event, broadcast) {
  const stream = broadcast?.streams[0];
  if (!stream) return;
  current = { event, broadcast };
  showDiag(`Запускаю ${broadcast.name}…`);
  const res = await window.api.vlcPlay(stream.url);
  showDiag(res.ok ? '' : `Не удалось запустить VLC: ${res.error}`);
}

function section(title, events) {
  const wrap = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  wrap.append(h);
  for (const e of events) wrap.append(matchCard(e));
  return wrap;
}

function renderFilters() {
  for (const b of el('filters').querySelectorAll('.filter')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  }
}

function render() {
  renderFilters();
  const list = el('list');
  list.replaceChildren();

  if (!guide || !guide.events.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = guide ? 'Матчей с трансляциями не нашлось.' : 'Сетки пока нет — нажмите «Обновить».';
    list.append(p);
    return;
  }

  const all = visibleEvents();
  const live = all.filter((e) => e.status === 'inprogress');
  const upcoming = all.filter((e) => e.status === 'notstarted');
  if (filter !== 'upcoming' && live.length) list.append(section('Сейчас в эфире', live));
  if (filter !== 'live' && upcoming.length) list.append(section('Предстоящие', upcoming));
  if (!list.children.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = filter === 'live' ? 'Сейчас никто не играет.' : 'Матчей не найдено.';
    list.append(p);
  }
}

el('filters').addEventListener('click', (e) => {
  const b = e.target.closest('.filter');
  if (!b) return;
  filter = b.dataset.filter;
  render();
});

// Два независимых темпа. Расписание и каналы меняются медленно, счёт — нет.
// Общий флаг: оба пути пишут guide.json, значит одновременно им нельзя.
let syncing = false;

async function doFullSync() {
  if (syncing) return;
  syncing = true;
  const btn = el('sync');
  const list = el('list');
  const scrollTop = list.scrollTop;
  btn.disabled = true;
  el('status').textContent = 'Синхронизация…';

  const res = await window.api.sync();
  btn.disabled = false;
  syncing = false;

  if (!res.ok) {
    el('status').textContent = `Не удалось обновить: ${res.error}`;
    return;
  }
  guide = res.guide;
  const s = guide.stats;
  el('status').textContent = `Обновлено ${TIME.format(new Date(guide.generatedAt))} · матчей ${s.events}`
    + ` · трансляций ${s.broadcasts}`
    + (s.indexReused ? ' · EPG из индекса' : ' · EPG разобран заново')
    + (s.reusedLinks ? ` · связей переиспользовано ${s.reusedLinks}` : '');
  render();
  list.scrollTop = scrollTop;
}

// Тихо: ни блокировки кнопки, ни сообщений — виден только результат.
async function doScoreRefresh() {
  if (syncing) return;
  syncing = true;
  const list = el('list');
  const scrollTop = list.scrollTop;
  const res = await window.api.refreshScores();
  syncing = false;
  if (!res.ok || !res.guide) return;
  guide = res.guide;
  render();
  list.scrollTop = scrollTop;
}

el('sync').addEventListener('click', doFullSync);

// Условие про плейлист, а не про уже собранную сетку: иначе упавший на
// запуске синк при отсутствии кэша оставлял бы приложение мёртвым навсегда.
let playlistReady = false;
setInterval(() => { if (playlistReady) doFullSync(); }, 60 * 60 * 1000);
setInterval(() => { if (playlistReady && !guide) doFullSync(); }, 5 * 60 * 1000);
setInterval(() => { if (guide) doScoreRefresh(); }, 3 * 60 * 1000);

window.api.onProgress(({ text }) => { el('status').textContent = text; });

(async () => {
  const pl = await window.api.playlistStatus();
  playlistReady = pl.exists;
  guide = await window.api.cachedGuide();

  if (!pl.exists) {
    el('status').textContent = pl.path
      ? `Не удалось загрузить плейлист: ${pl.error || 'проверьте config.json'}`
      : 'Плейлист не задан — укажите playlistPath в config.json';
  } else if (guide) {
    el('status').textContent = `Сетка от ${TIME.format(new Date(guide.generatedAt))} · каналов ${pl.count}`;
  } else {
    el('status').textContent = `Каналов в плейлисте ${pl.count} — нажмите «Обновить»`;
  }
  render();
  if (pl.exists) doFullSync();
})();
