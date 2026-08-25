'use strict';

const el = (id) => document.getElementById(id);

let guide = null;
let filter = 'all'; // 'all' | 'live' | 'upcoming'
let current = null; // { event, broadcast, streamIndex }

/* ---------------- playback (VLC, its own window) ---------------- */

function showDiag(message) {
  const diag = el('diag');
  diag.hidden = !message;
  diag.textContent = message || '';
}

async function play(event, broadcast, streamIndex = 0) {
  const stream = broadcast.streams[streamIndex];
  if (!stream) return;

  current = { event, broadcast, streamIndex };

  showDiag('Запускаю VLC…');
  const res = await window.api.vlcPlay(stream.url);
  showDiag(res.ok ? '' : `Не удалось запустить VLC: ${res.error}`);
  renderBar();
}

/* ---------------- guide rendering ---------------- */

const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });

function dateBadge(startMs) {
  const iso = new Date(startMs).toISOString().slice(0, 10);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const tomorrowIso = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  if (iso === todayIso) return 'Сегодня';
  if (iso === tomorrowIso) return 'Завтра';
  return DAY.format(new Date(startMs));
}

// A football match doesn't run past this from kickoff (regular + extra time
// + breaks, with slack). The last sync's status can go stale between syncs —
// this is the client-side backstop so a finished match doesn't sit there
// forever showing whatever minute it was at when we last synced.
const MATCH_MAX_MS = 150 * 60 * 1000;

function flatEvents() {
  const out = [];
  const cutoff = Date.now() - MATCH_MAX_MS;
  for (const day of guide.days) {
    for (const t of day.tournaments) {
      for (const e of t.events) if (e.start > cutoff) out.push(e);
    }
  }
  return out.sort((a, b) => a.start - b.start);
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

function chipFor(event, broadcast) {
  const chip = document.createElement('button');
  chip.className = 'chip';

  const flag = document.createElement('span');
  flag.className = 'flag';
  flag.textContent = broadcast.country || '';
  chip.append(flag, document.createTextNode(broadcast.name));

  chip.title = broadcast.streams.map((s) => s.name).join('\n');
  chip.addEventListener('click', () => play(event, broadcast, 0));
  return chip;
}

function leagueRow(event) {
  const row = document.createElement('div');
  row.className = 'league';
  if (event.tournamentLogo) row.append(crest(event.tournamentLogo, ''));
  const name = document.createElement('span');
  name.textContent = event.tournament;
  row.append(name);
  return row;
}

function teamsGrid(event) {
  const grid = document.createElement('div');
  grid.className = 'teams-grid';

  const rows = [
    { name: event.homeShort || event.home, logo: event.homeLogo, score: event.homeScore },
    { name: event.awayShort || event.away, logo: event.awayLogo, score: event.awayScore },
  ];
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.append(crest(r.logo, r.name));
    const name = document.createElement('span');
    name.className = 'team-name';
    name.textContent = r.name;
    row.append(name);
    grid.append(row);
  }

  const side = document.createElement('div');
  side.className = 'teams-side';
  if (event.status === 'notstarted') {
    side.classList.add('is-time');
    side.textContent = TIME.format(new Date(event.start));
  } else {
    const scores = document.createElement('div');
    scores.className = 'scores';
    for (const r of rows) {
      const s = document.createElement('span');
      s.textContent = r.score ?? 0;
      scores.append(s);
    }
    side.append(scores);
  }
  grid.append(side);
  return grid;
}

function venueLine(event) {
  if (!event.venue?.name) return null;
  const p = document.createElement('p');
  p.className = 'venue';
  p.textContent = [event.venue.name, event.venue.city].filter(Boolean).join(', ');
  return p;
}

function matchCard(event) {
  const card = document.createElement('article');
  card.className = 'match-card';
  if (event.status === 'inprogress') card.classList.add('is-live');
  if (event.tournamentColor) card.style.setProperty('--accent', event.tournamentColor);

  const top = document.createElement('div');
  top.className = 'card-top';
  top.append(leagueRow(event));

  const badge = document.createElement('span');
  if (event.status === 'inprogress') {
    badge.className = 'badge is-live';
    badge.append(document.createElement('i'));
    badge.append(document.createTextNode(event.clock ? `LIVE · ${event.clock}` : 'LIVE'));
  } else {
    badge.className = 'badge';
    badge.textContent = dateBadge(event.start);
  }
  top.append(badge);
  card.append(top);

  card.append(teamsGrid(event));

  const venue = venueLine(event);
  if (venue) card.append(venue);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const b of event.broadcasts) chips.append(chipFor(event, b));
  card.append(chips);

  if (event.broadcasts.length) {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.chip')) return;
      play(event, event.broadcasts[0], 0);
    });
  }
  return card;
}

function section(title, events) {
  const wrap = document.createElement('section');
  const h = document.createElement('h2');
  h.className = 'section-title';
  h.textContent = title;
  wrap.append(h);
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const e of events) grid.append(matchCard(e));
  wrap.append(grid);
  return wrap;
}

function renderList() {
  const list = el('list');
  list.replaceChildren();

  const all = flatEvents();
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

function renderFilters() {
  for (const b of el('filters').querySelectorAll('.filter')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  }
}

el('filters').addEventListener('click', (e) => {
  const b = e.target.closest('.filter');
  if (!b) return;
  filter = b.dataset.filter;
  renderFilters();
  renderList();
});

function renderBar() {
  const bar = el('bar');
  if (!current) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const { event, broadcast, streamIndex } = current;
  const stream = broadcast.streams[streamIndex];
  el('nowTeams').textContent = `${event.home} — ${event.away}`;
  el('nowMeta').textContent = stream.name;

  const field = el('variantField');
  const select = el('variant');
  field.hidden = broadcast.streams.length < 2;
  if (!field.hidden) {
    select.replaceChildren();
    broadcast.streams.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = s.name;
      o.selected = i === streamIndex;
      select.append(o);
    });
  }
}

function explainEmpty() {
  const s = guide?.stats;
  if (!s) return 'Сетки пока нет. Нажмите «Обновить» — первая синхронизация занимает несколько минут.';
  if (!s.fixtures) return 'FotMob не вернул расписание турниров. Проверьте соединение.';
  return 'Live-матчей и ближайших игр нет.';
}

function render() {
  if (!guide || !guide.days.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = explainEmpty();
    el('list').replaceChildren(p);
    renderBar();
    return;
  }
  renderFilters();
  renderList();
}

/* ---------------- wiring ---------------- */

// Two independent cadences: the schedule itself (which matches exist, which
// channels carry them) barely changes minute to minute, so it's only worth
// re-fetching on launch, hourly, or when asked for. Score/status/clock on
// matches already found is the part that's actually stale after a few
// minutes — that's the cheap, frequent one (see sync.js → refreshScores).
// One shared busy-flag between them: they both write guide.json, so they
// shouldn't run concurrently, and a scoring tick landing mid-resync isn't
// worth the complexity of two separate locks.
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
  const s = guide.stats || {};
  el('status').textContent = `Обновлено ${TIME.format(new Date(guide.generatedAt))} · матчей ${s.events ?? 0}`
    + ` · трансляций ${s.broadcasts ?? 0}`;
  render();
  list.scrollTop = scrollTop;
}

// Quiet on purpose — no button-disable, no status-line message, just
// whatever changed (a score ticking up, a match going LIVE or dropping off
// once it's finished) showing up in the next render. `guide.generatedAt`
// stays untouched here — it should keep meaning "last full sync", not
// "last time anything happened".
async function doScoreRefresh() {
  if (syncing) return;
  syncing = true;
  const list = el('list');
  const scrollTop = list.scrollTop;

  const res = await window.api.refreshScores();
  syncing = false;

  if (!res.ok || !res.guide) return; // nothing synced yet, or a transient failure — next tick retries
  guide = res.guide;
  render();
  list.scrollTop = scrollTop;
}

el('sync').addEventListener('click', doFullSync);

setInterval(() => { if (guide) doFullSync(); }, 60 * 60 * 1000);
setInterval(() => { if (guide) doScoreRefresh(); }, 3 * 60 * 1000);

window.api.onProgress(({ text, done, total }) => {
  el('status').textContent = total ? `${text} (${done}/${total})` : text;
});

el('variant').addEventListener('change', (e) => {
  play(current.event, current.broadcast, Number(e.target.value));
});

/* ---------------- settings dialog (playlist + EPG + VLC + tournaments) ---------------- */

function settingsError(message) {
  const p = el('settingsError');
  p.hidden = !message;
  p.textContent = message || '';
}

// Grouped by `country` (FotMob's own group name — see COMPETITIONS in
// fotmob.js), "International" first then alphabetical, same order FotMob's
// own competition directory uses. Static data (39 entries), no network call
// needed to render this — unlike the full 558-competition catalog tried and
// rejected earlier, this is just the curated default list with checkboxes.
function renderCompetitionsList(competitions, disabledIds) {
  const list = el('competitionsList');
  list.replaceChildren();

  const byCountry = new Map();
  for (const c of competitions) {
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }
  const countries = [...byCountry.keys()].sort((a, b) => {
    if (a === 'International') return -1;
    if (b === 'International') return 1;
    return a.localeCompare(b);
  });

  for (const country of countries) {
    const group = document.createElement('div');
    group.className = 'comp-group';
    const title = document.createElement('h3');
    title.className = 'comp-group-title';
    title.textContent = country;
    group.append(title);

    for (const c of byCountry.get(country)) {
      const label = document.createElement('label');
      label.className = 'comp-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(c.id);
      cb.checked = !disabledIds.includes(c.id);
      const span = document.createElement('span');
      span.textContent = c.name;
      label.append(cb, span);
      group.append(label);
    }
    list.append(group);
  }
}

function disabledCompetitionIds() {
  return [...el('competitionsList').querySelectorAll('input[type="checkbox"]')]
    .filter((cb) => !cb.checked)
    .map((cb) => Number(cb.value));
}

el('openSettings').addEventListener('click', async () => {
  const { playlistPath, epgUrl, vlcPath, competitions, disabledCompetitions } = await window.api.getSettings();
  el('playlistInput').value = playlistPath;
  el('epgInput').value = epgUrl;
  el('vlcPathInput').value = vlcPath;
  renderCompetitionsList(competitions, disabledCompetitions);
  settingsError('');
  el('settingsDialog').showModal();
});

el('browsePlaylist').addEventListener('click', async () => {
  const picked = await window.api.choosePlaylist();
  if (picked) el('playlistInput').value = picked;
});

el('browseVlcPath').addEventListener('click', async () => {
  const picked = await window.api.chooseVlcPath();
  if (picked) el('vlcPathInput').value = picked;
});

el('settingsCancel').addEventListener('click', () => el('settingsDialog').close());

el('settingsSave').addEventListener('click', async () => {
  const playlistPath = el('playlistInput').value.trim();
  const epgUrl = el('epgInput').value.trim();
  const vlcPath = el('vlcPathInput').value.trim();
  if (!playlistPath) { settingsError('Укажите файл или ссылку на плейлист'); return; }
  const res = await window.api.saveSettings({ playlistPath, epgUrl, vlcPath, disabledCompetitions: disabledCompetitionIds() });
  if (!res.ok) { settingsError(res.error); return; }
  el('settingsDialog').close();
  el('status').textContent = `Плейлист загружен: ${res.count} каналов · нажмите «Обновить»`;
});

(async () => {
  const pl = await window.api.playlistStatus();
  guide = await window.api.cachedGuide();

  if (!pl.exists) {
    el('status').textContent = pl.path
      ? `Не удалось загрузить плейлист: ${pl.error || 'проверьте «Настройки»'}`
      : 'Плейлист не выбран — нажмите «Настройки»';
  } else if (guide) {
    el('status').textContent = `Сетка от ${TIME.format(new Date(guide.generatedAt))} · каналов: ${pl.count}`;
  } else {
    el('status').textContent = `Каналов в плейлисте: ${pl.count} — нажмите «Обновить»`;
  }
  render();

  // Cached guide shows instantly above; a real sync still runs on every
  // launch so the schedule doesn't sit on whatever was last fetched,
  // possibly hours ago.
  if (pl.exists) doFullSync();
})();
