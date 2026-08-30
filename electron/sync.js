'use strict';
const path = require('path');
const store = require('./store');
const fotmob = require('./fotmob');
const epg = require('./epg');
const broadcasters = require('./broadcasters');
const playlist = require('./playlist');

const DAYS_BACK = 1;
const DAYS_FORWARD = 6;

// Same ±90 minutes epg.js searches around a kickoff — kept in step so the
// "is the EPG showing something else here?" cross-check looks at exactly
// the window the main matcher would have.
const WINDOW_MS = 90 * 60 * 1000;

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * @param onProgress (text) => void
 * @returns { generatedAt, channelCount, stats, days: [{ date, tournaments: [{ name, events: [...] }] }] }
 */
async function run(config, onProgress = () => {}) {
  const { channels, epgUrl } = await playlist.load(config.playlistPath);
  const url = config.epgUrl || epgUrl;
  if (!url) throw new Error('EPG-фид не найден: нет url-tvg в плейлисте и epgUrl в конфиге');

  onProgress('Скачиваю расписание турниров…');
  const fixtures = await fotmob.fixtures(DAYS_BACK, DAYS_FORWARD, onProgress, config.disabledCompetitions);

  onProgress('Скачиваю EPG…');
  const xml = await epg.loadXmltv(url);

  onProgress('Разбираю передачи…');
  const { list: progList, channelCount: scannedChannelCount } = epg.programmes(xml, channels);

  // Multiple playlist entries can share one tvg-id (quality variants), so
  // every broadcast card lists all of them as stream options.
  const byTvgId = new Map();
  for (const ch of channels) {
    if (!ch.id) continue;
    if (!byTvgId.has(ch.id)) byTvgId.set(ch.id, []);
    byTvgId.get(ch.id).push(ch);
  }
  for (const list of byTvgId.values()) list.sort((a, b) => b.quality - a.quality);

  onProgress('Сопоставляю с каналами…');
  // Only what's live or ahead — past results aren't what this app is for.
  const upcoming = fixtures.filter((f) => f.status !== 'finished');

  // EPG-title matches first: they're the trustworthy half (the title
  // literally names both teams), and the FotMob broadcaster source below
  // uses them to settle its own contradictions.
  const epgByFixture = new Map();
  for (const f of upcoming) {
    epgByFixture.set(f.id, new Set(epg.findBroadcastChannels(progList, f.home, f.away, f.start, f.homeShort, f.awayShort)));
  }

  // FotMob's own "where to watch" data, direct id lookup — a fast bonus on
  // top of the EPG-title search, not a replacement for it: covers
  // broadcasters whose own EPG never carries team names at all (Sky Sports
  // UK's "Saturday Night Football" style branded slots). It answers at the
  // rights-holder level rather than per-channel-per-minute, so it filters
  // its own contradictions internally — see dropUnsound() in
  // broadcasters.js. One country failing (or FotMob's endpoint changing
  // shape) doesn't block the rest of the sync — same resilience as
  // everything else FotMob-sourced here.
  let extraBroadcasts = new Map();
  try {
    const byFixtureId = new Map(upcoming.map((f) => [f.id, f]));
    extraBroadcasts = await broadcasters.findBroadcasters(
      upcoming, channels, onProgress,
      (fid, chId) => epgByFixture.get(fid)?.has(chId) || false,
      // Does the EPG contradict the claim — either by putting some *other*
      // fixture on that channel then (same "names both teams" bar as the
      // main path), or by showing a different sport entirely in the kickoff
      // slot? Both are direct evidence the channel wasn't carrying this
      // match, whatever FotMob's rights-level answer says.
      (fid, chId) => {
        const f = byFixtureId.get(fid);
        if (!f) return false;
        const lo = f.start - WINDOW_MS;
        const hi = f.start + WINDOW_MS;
        const progs = progList.filter((p) => p.channelId === chId && p.start >= lo && p.start <= hi);
        if (!progs.length) return false;
        const otherFixture = upcoming.some((o) => o.id !== fid
          && epg.findBroadcastChannels(progs, o.home, o.away, f.start, o.homeShort, o.awayShort).length > 0);
        if (otherFixture) return true;
        // A different sport starting anywhere between kickoff and roughly
        // the final whistle: the channel can't have been carrying this match
        // through that. Anything starting *before* kickoff is fair game —
        // that's just the preceding slot ending as the match begins — and
        // `programmes()` keeps no end times, so the match length stands in.
        return progs.some((p) => p.start >= f.start && p.start < f.start + WINDOW_MS && epg.isOtherSport(p.title));
      },
    );
  } catch (err) {
    onProgress(`Вещатели FotMob недоступны: ${err.message}`);
  }

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
        streams: streams.map((s) => ({
          id: s.id, name: s.name, url: s.url, logo: s.logo, quality: s.quality,
        })),
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

  const events = allEvents.filter((e) => e.broadcasts.length > 0);

  const dates = [...new Set(events.map((e) => dateKey(e.start)))].sort();
  const days = dates.map((date) => {
    const dayEvents = events.filter((e) => dateKey(e.start) === date);
    const byTournament = new Map();
    for (const e of dayEvents) {
      if (!byTournament.has(e.tournament)) byTournament.set(e.tournament, []);
      byTournament.get(e.tournament).push(e);
    }
    return {
      date,
      tournaments: [...byTournament.entries()]
        .map(([name, evs]) => ({ name, events: evs.sort((a, b) => a.start - b.start) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  const guide = {
    generatedAt: Date.now(),
    channelCount: channels.length,
    stats: {
      channels: scannedChannelCount,
      programmes: progList.length,
      fixtures: fixtures.length,
      events: events.length,
      broadcasts: broadcastCount,
    },
    days,
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
  const targets = [];
  for (const day of guide.days) {
    for (const t of day.tournaments) {
      for (const e of t.events) {
        if (e.start <= now && e.status !== 'finished') targets.push(e);
      }
    }
  }
  if (!targets.length) return guide;

  await Promise.all(targets.map(async (e) => {
    const fresh = await fotmob.matchStatus(e.id);
    if (!fresh) return;
    e.status = fresh.status;
    e.homeScore = fresh.homeScore;
    e.awayScore = fresh.awayScore;
    e.clock = fresh.clock;
  }));

  // Same "only live or ahead" rule as run() — a match that just finished
  // drops off here instead of waiting for the next full sync.
  let broadcastCount = 0;
  let eventCount = 0;
  for (const day of guide.days) {
    for (const t of day.tournaments) t.events = t.events.filter((e) => e.status !== 'finished');
    day.tournaments = day.tournaments.filter((t) => t.events.length > 0);
    for (const t of day.tournaments) {
      eventCount += t.events.length;
      for (const e of t.events) broadcastCount += e.broadcasts.length;
    }
  }
  guide.days = guide.days.filter((d) => d.tournaments.length > 0);
  guide.stats.events = eventCount;
  guide.stats.broadcasts = broadcastCount;

  store.writeJson(path.join(store.root, 'guide.json'), guide);
  return guide;
}

module.exports = { run, refreshScores };
