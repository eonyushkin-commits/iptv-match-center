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
function unpack(gz) {
  const decompressed = zlib.gunzipSync(gz);
  const xml = decompressed[0] === 0x3c /* '<' */ ? decompressed : untar(decompressed);
  if (!xml) throw new Error('Не удалось распаковать EPG-фид (неизвестный формат архива)');
  return xml.toString('utf8');
}

// Фид весит десятки мегабайт, так что таймаут щедрый: он здесь не про
// «медленно», а про «повисло навсегда». Без него подвисшая закачка вешала
// весь синк молча — с заблокированной кнопкой «Обновить» и без способа
// отменить.
const XMLTV_TIMEOUT_MS = 120000;

/** Файлы кэша разведены по URL (см. cachePath), но удалять их было некому:
 * на машине автора накопилось 170 МБ от четырёх разных провайдеров, и в
 * упакованной сборке это растёт в %APPDATA% у каждого, кто хоть раз сменил
 * источник. Протухшее всё равно будет перекачано — хранить его незачем. */
function pruneCache(keep) {
  let names;
  try {
    names = fs.readdirSync(store.root);
  } catch {
    return; // папки ещё нет — чистить нечего
  }
  for (const name of names) {
    if (!/^epg-[0-9a-f]+\.xml\.gz$/.test(name)) continue;
    const p = path.join(store.root, name);
    if (p === keep) continue;
    try {
      if (Date.now() - fs.statSync(p).mtimeMs >= XMLTV_TTL_MS) fs.unlinkSync(p);
    } catch { /* исчез сам или занят другим процессом — не наша забота */ }
  }
}

async function loadXmltv(url) {
  const file = cachePath(url);
  // На каждом заходе, а не только после закачки: пока текущий фид свежий,
  // закачки не происходит вовсе — и чужие протухшие файлы лежали бы до
  // ближайшего обновления. Стоит один readdir по горстке файлов.
  pruneCache(file);

  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < XMLTV_TTL_MS) {
    try {
      return unpack(fs.readFileSync(file));
    } catch {
      // Битый файл (оборвалась запись, кончилось место) держал бы синк
      // мёртвым все шесть часов TTL: mtime свежий, значит перекачки не будет,
      // а распаковка падает на каждом заходе. Выкидываем и качаем заново.
      try { fs.unlinkSync(file); } catch { /* уже нет */ }
    }
  }

  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(XMLTV_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  const gz = isGz ? buf : zlib.gzipSync(buf);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gz);
  return unpack(gz);
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

const CYRILLIC = /\p{Script=Cyrillic}/u;

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

    // XMLTV states the end time too. Nothing in the team search needs it —
    // that works off a window around kickoff — but the FotMob broadcaster
    // cross-check does: "was this channel showing something else when the
    // match kicked off?" is only answerable with a real end time. Guessing
    // a duration instead let a volleyball match that started an hour before
    // kickoff, and ran straight through it, pass as "just the previous
    // slot". Some feeds omit it, so callers must handle null.
    const stop = parseXmltvTime(attr(attrs, 'stop')) ?? null;

    out.push({ channelId, title, start, stop });
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
// "Athletic", "Real") globally: those are still needed — e.g. "Newcastle
// United"'s "Ньюкасл" transliterates too far from "newcastle" to
// Levenshtein-match, so "United"/"Юнайтед" is the only token that actually
// finds the fixture. See meaningfulTeamTokens() below for the other half of
// this: a word shared with the *opponent* is excluded per-fixture instead.
//
// "wanderers" added after a live false positive that neither of those two
// mechanisms could catch: "Bolton Wanderers" (own tokens: bolton, wanderers)
// matched a completely different fixture's title, "Wolverhampton Wanderers
// vs. Stoke City", purely on the shared "wanderers"/"city" suffixes -- the
// *opponent* was Lincoln City, which doesn't share either word, so
// meaningfulTeamTokens() had nothing to subtract; the collision was with a
// third team's match entirely, which no per-fixture exclusion can see.
// Confirmed safe to add globally: every "___ Wanderers" club tracked (Bolton,
// Wolverhampton, Wycombe) already has its own long, distinctive first word,
// so none of them actually depend on "wanderers" to be found.
const GENERIC_TEAM_TOKENS = new Set(['fc', 'cf', 'sc', 'afc', 'cfc', 'fk', 'ac', 'sk', 'wanderers']);

/**
 * Tokens worth matching for one side of a fixture: the club's own tokens,
 * minus globally-generic suffixes (GENERIC_TEAM_TOKENS) and minus anything
 * also present in the *opponent's* name. That second part matters even for
 * words that aren't globally generic: "Cardiff City" vs "Norwich City" share
 * "city", and demanding just one matching token per side meant a title
 * containing bare "city" (a kids' cartoon, a travel show, completely
 * unrelated) satisfied *both* teams at once — 16 false-positive channels on
 * one card, caught live. Falls back to the less-filtered token list only if
 * filtering would otherwise leave nothing to match on at all.
 */
function meaningfulTeamTokens(teamTokens, opponentTokens) {
  const opponentSet = new Set(opponentTokens);
  const withoutGeneric = teamTokens.filter((t) => !GENERIC_TEAM_TOKENS.has(t));
  const distinctive = withoutGeneric.filter((t) => !opponentSet.has(t));
  if (distinctive.length) return distinctive;
  if (withoutGeneric.length) return withoutGeneric;
  return teamTokens;
}

/** Does this team plausibly appear somewhere in the programme title?
 * `meaningfulTokens` drives the cheap/Levenshtein checks; `fullTokens` (the
 * unfiltered team name) still goes into the whole-string similarity
 * fallback, which is a high-bar comparison and doesn't need the filtering.
 * `titleWasCyrillic` refers to the *raw* title, before tokenising — by the
 * time we have tokens everything is Latin, so the caller has to remember. */
function teamInTitle(meaningfulTokens, titleTokenSet, fullTokens, titleWasCyrillic) {
  if (!meaningfulTokens.length) return false;
  // One matching token is enough — City/qualifier words ("Moscow", "St
  // Petersburg") are the least reliable part of a team name to match: they
  // transliterate inconsistently ("Москва" -> "moskva", not "moscow") and
  // broadcasters often wrap them in parentheses, which normalize.tokens()
  // strips outright (it was written for channel names, where "(HD)" is
  // noise). Demanding more than the club's own distinctive name would zero
  // out most Russian-league fixtures — verified live against "Zenit St
  // Petersburg".
  if (meaningfulTokens.some((t) => titleTokenSet.has(t))) return true;

  // Cyrillic transliteration is letter-by-letter, not the "official" foreign
  // spelling, and the two disagree often: "Барселона" -> "barselona" (с -> s)
  // vs the real "Barcelona" (c), "Ювентус" -> "yuventus" vs "Juventus" (ю ->
  // yu, not j), "Юнайтед" -> "yunaited" vs "United" (distance 2 at length 6)
  // — a flat "distance <= 2" tolerance is far too loose for *short* tokens
  // though: "Lille" (5) vs an unrelated "Killer" or "Hill" is also distance
  // 2, but that's half the word, not an edit-noise margin — matched a
  // Lille–PSG fixture to a German crime show and a "Silent Hill" listing on
  // live data, caught live. A flat cutoff can't fit both — length 6 needs
  // distance 2 allowed, length 5 needs it refused — so the allowance scales
  // with token length (~1 edit per 3 characters) instead of one fixed number.
  //
  // That whole allowance only makes sense for a title that *was* Cyrillic:
  // the noise it forgives is transliteration noise. A title already written
  // in Latin has no such gap — at most a dropped diacritic ("Malaga" for
  // "Málaga", "Besiktas" for "Beşiktaş"), which is a character *swap* and so
  // never changes the word's length. Insertions and deletions in a Latin
  // title mean a genuinely different word, and at distance 2 unrelated words
  // collide readily: a Nat Geo documentary, "Malika: la reina leona", matched
  // BOTH sides of Rodina–Baltika at once (rodina~reina, baltika~malika, two
  // edits each) and put a wildlife channel on an RPL card, caught live. So
  // for Latin titles the fuzzy step is narrowed to equal-length tokens.
  for (const t of meaningfulTokens) {
    if (t.length < 5) continue;
    const maxDist = Math.floor(t.length / 3);
    for (const titleToken of titleTokenSet) {
      if (Math.abs(titleToken.length - t.length) > 2) continue;
      if (!titleWasCyrillic && titleToken.length !== t.length) continue;
      if (levenshtein(t, titleToken) <= maxDist) return true;
    }
  }

  // Token-set match catches "Реал Мадрид" vs "Real Madrid" (translit resolves
  // both to the same tokens) but not looser spelling drift, so fall back to
  // the fuzzy channel-name comparator against the whole title.
  return similarity(fullTokens.join(' '), [...titleTokenSet].join(' ')) >= TEAM_THRESHOLD;
}

const WINDOW_MS = 90 * 60 * 1000;

// Токены заголовка и его алфавит — по первому обращению, дальше с самой
// передачи. findBroadcastChannels() зовётся для каждого матча и раньше
// токенизировала одни и те же заголовки по кругу: на живом фиде это 208 тысяч
// вызовов вместо 69 тысяч передач, которые вообще попадают хоть в чьё-то окно
// (весь фид — 306 тысяч, но большая его часть не лежит рядом ни с одним
// свистком и трогать её незачем).
//
// `cyr` считается по СЫРОМУ заголовку: к моменту токенизации всё уже
// латиница, а нечёткая ветка teamInTitle() зависит именно от исходного
// алфавита — на этом легко ошибиться.
const titleTokens = (p) => (p.tok ??= new Set(tokens(p.title)));
const titleIsCyrillic = (p) => (p.cyr ??= CYRILLIC.test(p.title));

/** Индекс первой передачи, начинающейся не раньше `ms`. Список отсортирован
 * по началу, так что окно вокруг свистка — это срез, а не проход с головы:
 * раньше каждый матч прокручивал весь список целиком (306 тысяч передач на
 * каждый из полутора сотен матчей), чтобы дойти до своих трёх часов. */
function firstAtOrAfter(list, ms) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Clubs whose real Russian broadcast name doesn't derive from transliterating
// the FotMob (English/local) name at all — a translated exonym ("Bayern
// München" is called "Бавария", the region name, not a rendering of
// "Bayern"), a Cyrillic-only abbreviation FotMob's own shortName can't supply
// ("ПСЖ" for PSG — "псж" transliterates to nothing like "PSG"), or a name
// short/diacritic-heavy enough that the Levenshtein fallback structurally
// can't bridge it (see epg.js's `teamInTitle` — the length-5 floor blocks
// "Köln"/"keln", diacritics like ş/ç never survive translit's Cyrillic-only
// map). Found by walking every team across all 39 tracked tournaments and
// checking which ones have no plain-ASCII fallback token, then verifying
// each candidate spelling against this exact matching logic (and, for the
// less obvious ones, a live search) rather than guessing — see CLAUDE.md.
// Deliberately small: the vast majority of teams already match fine through
// transliteration alone, this only covers the confirmed exceptions.
const RU_NICKNAMES = {
  'Bayern München': 'Бавария',
  'Paris Saint-Germain': 'ПСЖ',
  '1. FC Köln': 'Кёльн',
  'Beşiktaş': 'Бешикташ',
  'FC København': 'Копенгаген',
  'Başakşehir': 'Башакшехир',
  'Raków Częstochowa': 'Ракув Ченстохова',
  'Huracán': 'Уракан',
  'Çorum FK': 'Чорум',
  // English-pronunciation transliteration, not spelling transliteration —
  // "Eagles" said aloud collapses the "ea" to one long "и" sound, nothing
  // like the letter-by-letter "eagles" the team's own name tokenizes to.
  // Found live: a real "АЗ Алкмаар – Гоу Эхед Иглс" broadcast existed and
  // wasn't matched, caught during a same-day audit against FotMob's own
  // schedule (see CLAUDE.md).
  'Go Ahead Eagles': 'Гоу Эхед Иглс',
};

/** Distinct non-empty name forms for one side: the full name, FotMob's own
 * short name, and a curated Russian nickname, whichever apply. */
function nameForms(name, alt) {
  return [...new Set([name, alt, RU_NICKNAMES[name]].filter(Boolean))];
}

/**
 * Finds which EPG channels carry a known fixture: programmes on sport
 * channels within ±90 minutes of kickoff whose title names both teams.
 * `progList` must be sorted by start (as returned by `programmes()`).
 *
 * `homeAlt`/`awayAlt` are FotMob's own short names (`homeShort`/`awayShort`
 * in sync.js) — optional, only used when they actually differ from the full
 * name. Broadcasters often abbreviate ("Lille – PSG", not "Lille – Paris
 * Saint-Germain") and the full-name-only match was silently missing those:
 * live-checked on Lille–PSG, the full name found 2 channels, "PSG" found 3
 * *more* that the full name never could. Short names are 2-4 letters, below
 * the Levenshtein branch's length-5 floor and too short for the whole-string
 * similarity fallback to false-positive on — so this only ever adds exact
 * literal matches, no new fuzzy surface. `RU_NICKNAMES` (above) folds in the
 * same way as a third form, for the handful of clubs where translit itself
 * can't bridge the gap at all.
 */
function findBroadcastChannels(progList, home, away, kickoffMs, homeAlt, awayAlt) {
  const homeForms = nameForms(home, homeAlt).map((f) => ({ form: f, tokens: tokens(f) })).filter((f) => f.tokens.length);
  const awayForms = nameForms(away, awayAlt).map((f) => ({ form: f, tokens: tokens(f) })).filter((f) => f.tokens.length);
  if (!homeForms.length || !awayForms.length) return [];

  // Opponent's token pool spans every form on their side, so a word shared
  // with any of them — including a nickname or short-name collision — still
  // gets excluded (same reasoning as the Cardiff City/Norwich City fix).
  const homePool = homeForms.flatMap((f) => f.tokens);
  const awayPool = awayForms.flatMap((f) => f.tokens);
  for (const f of homeForms) f.meaningful = meaningfulTeamTokens(f.tokens, awayPool);
  for (const f of awayForms) f.meaningful = meaningfulTeamTokens(f.tokens, homePool);

  const lo = kickoffMs - WINDOW_MS;
  const hi = kickoffMs + WINDOW_MS;
  const channelIds = new Set();

  for (let i = firstAtOrAfter(progList, lo); i < progList.length; i++) {
    const p = progList[i];
    if (p.start > hi) break; // sorted by start — nothing further can match
    const tt = titleTokens(p);
    const wasCyrillic = titleIsCyrillic(p);
    const homeHit = homeForms.some((f) => teamInTitle(f.meaningful, tt, f.tokens, wasCyrillic));
    const awayHit = awayForms.some((f) => teamInTitle(f.meaningful, tt, f.tokens, wasCyrillic));
    if (homeHit && awayHit) {
      channelIds.add(p.channelId);
    }
  }

  return [...channelIds];
}

// Sports that aren't football, named plainly enough in a programme title to
// settle the question. Only used to *reject* a claim from the FotMob
// broadcaster source (see broadcasters.js) when the channel demonstrably had
// something else on: that source answers at the rights-holder level, so it
// happily says "Матч ТВ" for a match that channel wasn't actually carrying —
// caught live with motorsport ("Автоспорт. Российская серия кольцевых
// гонок") and basketball ("Швеция – Франция. Баскетбол") sitting in the
// exact kickoff slot. Deliberately not consulted by the normal title search:
// there a title has to name both teams anyway, which no other sport's
// listing will do by accident.
// Unicode-aware boundaries, NOT `\b`: JavaScript's `\b` is defined against
// ASCII `\w`, so a Cyrillic word has no word boundary at its edges and
// `\bавтоспорт\b` silently never matches — the whole guard quietly did
// nothing until a live run showed the motorsport listing still slipping
// through.
const OTHER_SPORTS = /(?<!\p{L})(баскетбол|хоккей|теннис|волейбол|гандбол|автоспорт|мотоспорт|биатлон|бокс|регби|гольф|крикет|дартс|снукер|формула|хокей|siatkówka|siatkowka|koszykówka|koszykowka|hokej|żużel|zuzel|tenis|volleyball|basketball|eishockey|handball|volei|baschet|hochei|handbal|pallavolo|pallamano|basket|voleibol|baloncesto|balonmano|basquetebol|hóquei|hoquei|andebol|ténis|voleybol|basketbol|hentbol|hokey|volejbal|basketbal|házená|hazena|volleybal|ijshockey|volleyboll|ishockey|handboll|hockey|tennis|motorsport|biathlon|boxing|rugby|golf|cricket|darts|snooker|nba|nhl|mlb|ufc)(?!\p{L})/iu;

/** Does this programme title plainly announce a different sport? */
function isOtherSport(title) {
  return OTHER_SPORTS.test(title);
}

module.exports = { loadXmltv, programmes, findBroadcastChannels, isOtherSport, attr, tag };
