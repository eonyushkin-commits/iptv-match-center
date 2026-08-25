'use strict';

// FotMob's own undocumented JSON API — no key, no account, no request signing
// (unlike Sofascore, which now 404s on its whole /api/v1/* tree — checked
// live before switching). Same low-risk profile as ESPN before it: if it
// ever breaks, fixtures just stop refreshing, nothing else in the app is
// affected. Chosen over ESPN because it actually has the domestic cups ESPN
// doesn't (Belgium, Portugal, Russia, Turkey) — verified live per
// competition before adding, same as always. Must run through Electron's
// `net` (Chromium's stack) — plain Node fetch gets blocked the same way
// Sofascore/TheSportsDB do.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function pickFetch() {
  try {
    const { net } = require('electron');
    if (net?.fetch) return net.fetch.bind(net);
  } catch { /* not running inside Electron */ }
  return globalThis.fetch;
}

// FotMob league ids — hardcoded, not in config.json (personal single-user
// app, a config knob nobody else will ever touch). Verified live via
// https://www.fotmob.com/api/data/allLeagues before adding each one.
// Names are FotMob's own English labels (`allLeagues`/`leagues?id=` →
// `details.name`), not translated — explicit user request, and it also
// keeps this list's names in sync with what actually shows on the card
// (which already pulls `details.name`/`details.country` straight from
// FotMob, see competitionFixtures() below — this `name` is only ever used
// for the sync progress line, "Расписание: …").
const COMPETITIONS = [
  // Leagues
  { id: 47, name: 'Premier League' },
  { id: 48, name: 'Championship' },
  { id: 87, name: 'LaLiga' },
  { id: 55, name: 'Serie A' },
  { id: 54, name: 'Bundesliga' },
  { id: 146, name: '2. Bundesliga' },
  { id: 53, name: 'Ligue 1' },
  { id: 42, name: 'Champions League' },
  { id: 73, name: 'Europa League' },
  { id: 10216, name: 'Conference League' },
  // Основной этап ЛЧ/ЛЕ/ЛК начинается позже (сентябрь) и на момент добавления
  // ещё стоит на прошлом сезоне у FotMob — прямо сейчас вся активность идёт
  // в квалификационных раундах, это отдельные турниры на их стороне, не то
  // же самое, что «Лига чемпионов» с пустым расписанием.
  { id: 10611, name: 'Champions League Qualification' },
  { id: 10613, name: 'Europa League Qualification' },
  { id: 10615, name: 'Conference League Qualification' },
  { id: 61, name: 'Liga Portugal' },
  { id: 57, name: 'Eredivisie' },
  { id: 40, name: 'First Division A' },
  { id: 63, name: 'Premier League' },
  { id: 71, name: 'Süper Lig' },
  { id: 130, name: 'MLS' },
  { id: 64, name: 'Premiership' },
  // Cups & super cups — только топ-5 (Англия/Испания/Италия/Германия/
  // Франция) и Россия, по прямой просьбе пользователя. Кубки остальных
  // стран (Нидерланды, Бельгия, Португалия, Турция, Бразилия, Аргентина)
  // здесь были и убраны — их лиги при этом остались выше.
  { id: 132, name: 'FA Cup' },
  { id: 133, name: 'EFL Cup' },
  { id: 247, name: 'Community Shield' },
  { id: 138, name: 'Copa del Rey' },
  { id: 139, name: 'Supercopa de España' },
  { id: 141, name: 'Coppa Italia' },
  { id: 222, name: 'Supercoppa' },
  { id: 209, name: 'DFB Pokal' },
  { id: 8924, name: 'Super Cup' },
  { id: 134, name: 'Coupe de France' },
  { id: 207, name: 'Trophée des champions' },
  // Russia — every tournament FotMob tracks, not just RPL + Cup (explicit
  // user request: "для России все турниры").
  { id: 193, name: 'Russian Cup' },
  { id: 195, name: 'Super Cup' },
  { id: 338, name: '1. Division' },
  { id: 9333, name: 'Premier League Qualification' },
  { id: 9123, name: 'Second League' },
  // Бразилия, Аргентина — главная лига (без кубка, см. выше). Беларусь была
  // здесь же, убрана по прямой просьбе пользователя (слишком много ненужных
  // турниров в дефолтном списке).
  { id: 268, name: 'Serie A' },
  { id: 112, name: 'Liga Profesional' },
  // Отдельной квалификации у Копа Либертадорес на FotMob нет (в отличие от
  // УЕФА) — ранние раунды идут внутри самого турнира, один и тот же id.
  // Континентальный турнир, не подпадает под «кубки только топ-5+Россия».
  { id: 45, name: 'Copa Libertadores' },
];

// FotMob's own bare league name is often ambiguous on its own ("Cup",
// "Super Cup", "1. Division", "Premier League" all exist for more than one
// country) — FotMob's own site always pairs it with the country, so the
// card does the same: "Russia - Premier League", not just "Premier League"
// next to English club names that don't carry a translated tournament label
// at all. `details.country` is FotMob's own short code, not ISO-3166 (e.g.
// "ENG" for England specifically, not "GBR") — small fixed table, same
// spirit as COMPETITIONS itself. `null` means no country prefix (UEFA
// competitions, international).
const COUNTRY_NAMES = {
  ENG: 'England', ESP: 'Spain', ITA: 'Italy', GER: 'Germany', FRA: 'France',
  POR: 'Portugal', NED: 'Netherlands', BEL: 'Belgium', RUS: 'Russia',
  TUR: 'Turkey', USA: 'USA', BRA: 'Brazil', ARG: 'Argentina', BLR: 'Belarus',
  INT: null,
};

// Deterministic static image paths — no extra API call per team/league, and
// no stale-crest override table like ESPN needed for RPL (FotMob's own RPL
// crest is current — checked live).
function teamLogo(id) {
  return id != null ? `https://images.fotmob.com/image_resources/logo/teamlogo/${id}.png` : null;
}
function leagueLogo(id) {
  return `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`;
}

function statusOf(s) {
  if (!s) return 'notstarted';
  // A cancelled/abandoned fixture is resolved as far as this app cares —
  // sync.js drops anything with status 'finished' from the "upcoming" list,
  // which is exactly right for a match that's never going to be shown live.
  if (s.finished || s.cancelled) return 'finished';
  if (s.started) return 'inprogress';
  return 'notstarted';
}

function parseScore(scoreStr) {
  const m = typeof scoreStr === 'string' ? scoreStr.match(/(\d+)\s*-\s*(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}

/**
 * Every fixture for one competition, current season, filtered down to
 * [today-daysBack, today+daysForward]. Unlike ESPN's scoreboard endpoint,
 * FotMob's league endpoint has no date-range parameter — it always returns
 * the whole season, so the window is applied client-side.
 */
async function competitionFixtures(id, name, daysBack, daysForward) {
  const url = `https://www.fotmob.com/api/data/leagues?id=${id}`;
  const res = await pickFetch()(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.fotmob.com/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} league ${id}`);
  const json = await res.json();
  const allMatches = json.fixtures?.allMatches || json.overview?.matches?.allMatches || [];
  // FotMob's own brand colour for the competition — present for every
  // competition checked so far, down to obscure ones (Russian Second
  // League), generic ones just fall back to a neutral dark grey (#333333).
  const color = json.details?.leagueColor || null;
  // Match FotMob's own "Country - League" label — see COUNTRY_NAMES above.
  // `?? ` alone can't tell "mapped to null on purpose" (INT: no prefix)
  // apart from "code isn't in the table at all" (fall back to showing the
  // raw code) — both look the same to `??`, so check membership explicitly.
  const countryCode = json.details?.country;
  const countryName = countryCode in COUNTRY_NAMES ? COUNTRY_NAMES[countryCode] : (countryCode ?? null);
  const leagueName = json.details?.name || name;
  const competition = countryName ? `${countryName} - ${leagueName}` : leagueName;

  const now = Date.now();
  const from = now - daysBack * 86400000;
  const to = now + daysForward * 86400000;

  return allMatches
    .map((m) => {
      const start = new Date(m.status?.utcTime).getTime();
      const [homeScore, awayScore] = parseScore(m.status?.scoreStr);
      return {
        id: m.id,
        competition,
        competitionLogo: leagueLogo(id),
        competitionColor: color,
        home: m.home?.name || '',
        away: m.away?.name || '',
        homeShort: m.home?.shortName || m.home?.name || '',
        awayShort: m.away?.shortName || m.away?.name || '',
        homeLogo: teamLogo(m.home?.id),
        awayLogo: teamLogo(m.away?.id),
        homeScore,
        awayScore,
        start,
        status: statusOf(m.status),
        // Neither available from this list endpoint — clock is filled in
        // separately, only for matches actually in progress (see
        // `matchStatus` below); venue would need the same per-match
        // `matchDetails` call again for a much less useful payoff, so it
        // stays omitted (renderer already handles a missing venue gracefully).
        clock: null,
        venue: null,
      };
    })
    .filter((f) => Number.isFinite(f.start) && f.start >= from && f.start <= to);
}

/**
 * Fresh status/score/clock for one match, straight from `matchDetails` — a
 * couple of matches at any given moment need this, not the whole list, so
 * one request per match is cheap. The minute specifically lives at
 * `header.status.liveTime.short` (not `general.status`, which doesn't carry
 * it — see CLAUDE.md for how that got found out the hard way), wrapped in
 * typographic/directional-mark cruft ("67‎'‎") that gets stripped down to
 * digits (+ "+N" for stoppage time) and a plain apostrophe of our own.
 *
 * Used two ways: (1) folded into a full sync, right after fetching a
 * competition's list, to fill in `clock` for whatever's already
 * `inprogress`; (2) driving `sync.refreshScores()`'s lightweight cycle,
 * where it's the only request made per match — no need to touch the bulk
 * `leagues?id=` endpoint just to see whether a score changed.
 */
async function matchStatus(matchId) {
  try {
    const url = `https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`;
    const res = await pickFetch()(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.fotmob.com/' } });
    if (!res.ok) return null;
    const json = await res.json();
    const s = json.header?.status;
    if (!s) return null;
    const [homeScore, awayScore] = parseScore(s.scoreStr);
    const short = s.liveTime?.short;
    const digits = typeof short === 'string' ? short.replace(/[^\d+]/g, '') : '';
    return { status: statusOf(s), homeScore, awayScore, clock: digits ? `${digits}'` : null };
  } catch {
    return null;
  }
}

/** All configured competitions. One competition failing doesn't sink the rest. */
async function fixtures(daysBack, daysForward, onProgress = () => {}) {
  const all = [];
  for (const c of COMPETITIONS) {
    onProgress(`Расписание: ${c.name}`);
    try {
      all.push(...(await competitionFixtures(c.id, c.name, daysBack, daysForward)));
    } catch (err) {
      onProgress(`${c.name}: ${err.message}`);
    }
  }

  const live = all.filter((f) => f.status === 'inprogress');
  if (live.length) {
    onProgress('Уточняю минуту живых матчей…');
    await Promise.all(live.map(async (f) => { f.clock = (await matchStatus(f.id))?.clock ?? null; }));
  }

  return all;
}

module.exports = { fixtures, matchStatus };
