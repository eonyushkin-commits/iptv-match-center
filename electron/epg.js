'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./store');
const { tokens, similarity } = require('./normalize');

const XMLTV_TTL_MS = 6 * 3600 * 1000;

// Keyed by URL (not a fixed name) — otherwise switching EPG providers within
// the TTL window would silently keep serving the previous provider's cached
// feed: same file, still "fresh", wrong channel ids, guide ends up empty
// with no error at all. Found live testing an Antifriz-provider playlist
// right after using the default epg.team one.
function cachePath(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(store.root, `epg-${hash}.xml.gz`);
}

/** Pulls the first regular file's bytes out of a POSIX tar archive — a
 * provider's ".xml.tar.gz" combo is a gzip-compressed tar containing one
 * XML file, not gzipped XML directly. No tar library for reading one file
 * out of one archive; format detected from content (magic bytes / leading
 * "<"), not from the URL, so it doesn't matter which provider it came from. */
function untar(buf) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*/s, '').trim(), 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;
    if ((typeFlag === '0' || typeFlag === '\0') && size > 0) return buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512; // content is padded to a 512-byte boundary
  }
  return null;
}

/**
 * Downloads and gzip-caches the XMLTV feed; returns the decompressed text.
 * The cache always holds gzip bytes regardless of what was actually
 * downloaded (plain XML gets gzipped before writing) — from there,
 * decompressing is always exactly one `gunzipSync` away from either XML
 * text directly or, for a tar.gz feed, a tar archive with the XML inside.
 */
async function loadXmltv(url) {
  const file = cachePath(url);
  let gz;
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < XMLTV_TTL_MS) {
    gz = fs.readFileSync(file);
  } else {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
    gz = isGz ? buf : zlib.gzipSync(buf);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gz);
  }
  const decompressed = zlib.gunzipSync(gz);
  const xml = decompressed[0] === 0x3c /* '<' */ ? decompressed : untar(decompressed);
  if (!xml) throw new Error('Не удалось распаковать EPG-фид (неизвестный формат архива)');
  return xml.toString('utf8');
}

// Attribute order varies between feeds (and even within one — `channel` comes
// before `start` here), so attributes are read by name, never positionally.
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Titles carry raw XML entities ("&#34;Эльче&#34;") — left undecoded, that
// stray "34" reads as a digit token and silently defeats the fuzzy team-name
// comparator, which hard-rejects any pair with mismatched digit tokens.
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

/** "20260820184500 +0000" -> ms since epoch. */
function parseXmltvTime(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  const offsetMin = tz ? (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) : 0;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offsetMin * 60000;
}

/**
 * Every programme, on every channel the playlist actually has, sorted by
 * start time — no "is this a sport channel" pre-filter by group or name.
 * That heuristic used to gate this (group number, then channel-name
 * keywords) but it's provider-specific (a different provider's sport group
 * might not even have a number, e.g. plain "Спорт" instead of "9.
 * Sport/Спорт") and misses real matches on generalist channels outright —
 * the national team on Первый, a German Cup tie on ARD, neither named or
 * grouped as "sport" at all. Scanning every known channel costs more CPU
 * per sync, but `findBroadcastChannels()` below is what actually decides
 * whether a given programme is a match worth surfacing, so the correctness
 * cost of a narrower pre-filter was never worth it.
 */
function programmes(xmlText, channels) {
  const knownIds = new Set(channels.map((c) => c.id).filter(Boolean));
  const out = [];

  for (const m of xmlText.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attrs = m[1];
    const channelId = attr(attrs, 'channel');
    if (!knownIds.has(channelId)) continue;

    const start = parseXmltvTime(attr(attrs, 'start'));
    if (start == null) continue;
    const title = tag(m[2], 'title');
    if (!title) continue;

    out.push({ channelId, title, start });
  }

  out.sort((a, b) => a.start - b.start);
  return { list: out, channelCount: knownIds.size };
}

const TEAM_THRESHOLD = 78;

/** Classic edit distance — short strings only, no need for anything fancier. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Short club-suffix abbreviations shared by dozens of clubs ("Toronto FC",
// "New York City FC") AND common outside football entirely. On their own
// they carry no identifying signal — matching bare "fc" against an unrelated
// title ("Bare Knuckle FC", a boxing broadcast) produced a false-positive
// card for Toronto FC–NYCFC on a channel that never showed the match, caught
// live. Deliberately NOT filtering longer qualifier words ("United", "City",
// "Athletic", "Real"): those are still needed — e.g. "Newcastle United"'s
// "Ньюкасл" transliterates too far from "newcastle" to Levenshtein-match,
// so "United"/"Юнайтед" is the only token that actually finds the fixture.
const GENERIC_TEAM_TOKENS = new Set(['fc', 'cf', 'sc', 'afc', 'cfc', 'fk', 'ac', 'sk']);

/** Does this team plausibly appear somewhere in the programme title? */
function teamInTitle(teamTokens, titleTokenSet) {
  if (!teamTokens.length) return false;
  // One matching token is enough — but only among the club's distinctive
  // tokens, never a bare generic suffix alone (see GENERIC_TEAM_TOKENS).
  // City/qualifier words ("Moscow", "St Petersburg") are the least reliable
  // part of a team name to match: they transliterate inconsistently
  // ("Москва" -> "moskva", not "moscow") and broadcasters often wrap them in
  // parentheses, which normalize.tokens() strips outright (it was written
  // for channel names, where "(HD)" is noise). Demanding more than the
  // club's own distinctive name would zero out most Russian-league fixtures
  // — verified live against "Zenit St Petersburg".
  const distinctiveTokens = teamTokens.filter((t) => !GENERIC_TEAM_TOKENS.has(t));
  const meaningfulTokens = distinctiveTokens.length ? distinctiveTokens : teamTokens;
  if (meaningfulTokens.some((t) => titleTokenSet.has(t))) return true;

  // Cyrillic transliteration is letter-by-letter, not the "official" foreign
  // spelling, and the two disagree often: "Барселона" -> "barselona" (с -> s)
  // vs the real "Barcelona" (c), "Ювентус" -> "yuventus" vs "Juventus" (ю ->
  // yu, not j). One or two edits on a same-length-ish token catches this
  // without hand-listing club names.
  for (const t of meaningfulTokens) {
    if (t.length < 5) continue;
    for (const titleToken of titleTokenSet) {
      if (Math.abs(titleToken.length - t.length) > 2) continue;
      if (levenshtein(t, titleToken) <= 2) return true;
    }
  }

  // Token-set match catches "Реал Мадрид" vs "Real Madrid" (translit resolves
  // both to the same tokens) but not looser spelling drift, so fall back to
  // the fuzzy channel-name comparator against the whole title.
  return similarity(teamTokens.join(' '), [...titleTokenSet].join(' ')) >= TEAM_THRESHOLD;
}

const WINDOW_MS = 90 * 60 * 1000;

/**
 * Finds which EPG channels carry a known fixture: programmes on sport
 * channels within ±90 minutes of kickoff whose title names both teams.
 * `progList` must be sorted by start (as returned by `programmes()`).
 */
function findBroadcastChannels(progList, home, away, kickoffMs) {
  const homeTokens = tokens(home);
  const awayTokens = tokens(away);
  if (!homeTokens.length || !awayTokens.length) return [];

  const lo = kickoffMs - WINDOW_MS;
  const hi = kickoffMs + WINDOW_MS;
  const channelIds = new Set();

  for (const p of progList) {
    if (p.start < lo) continue;
    if (p.start > hi) break; // sorted by start — nothing further can match
    const titleTokens = new Set(tokens(p.title));
    if (teamInTitle(homeTokens, titleTokens) && teamInTitle(awayTokens, titleTokens)) {
      channelIds.add(p.channelId);
    }
  }

  return [...channelIds];
}

module.exports = { loadXmltv, programmes, findBroadcastChannels, attr, tag };
