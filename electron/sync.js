'use strict';
const path = require('path');
const store = require('./store');
const fotmob = require('./fotmob');
const epg = require('./epg');
const playlist = require('./playlist');

const DAYS_BACK = 1;
const DAYS_FORWARD = 6;

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
  let broadcastCount = 0;
  // Only what's live or ahead — past results aren't what this app is for.
  const upcoming = fixtures.filter((f) => f.status !== 'finished');
  const allEvents = upcoming.map((f, i) => {
    const channelIds = epg.findBroadcastChannels(progList, f.home, f.away, f.start);
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
