'use strict';

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ї: 'i', і: 'i', є: 'e', ґ: 'g',
};

// Both sides collapse onto the same canonical word, so "Матч" and "Match"
// meet in the middle instead of one being transliterated into the other.
const CANON = {
  матч: 'match', матчь: 'match',
  футбол: 'football', футбольный: 'football', fussball: 'football', calcio: 'football', futbol: 'football',
  спорт: 'sport', спорта: 'sport', спортивный: 'sport', sports: 'sport', spor: 'sport', sportas: 'sport',
  хоккей: 'hockey', хоккея: 'hockey',
  баскетбол: 'basketball', баскетбола: 'basketball', basket: 'basketball',
  теннис: 'tennis',
  волейбол: 'volleyball',
  бокс: 'box', boxing: 'box',
  премьер: 'premier', премьера: 'premier', premiership: 'premier',
  борьба: 'fight', fighting: 'fight', fightbox: 'fight',
  евроспорт: 'eurosport',
};

// Carried by nearly every name, so they add noise rather than signal.
const STOP = new Set(['tv', 'hd', 'fhd', 'uhd', 'sd', 'hdr', '4k', '50fps',
  'double', 'backup', 'rez', 'канал', 'channel', 'kanal', 'the', 'sat', 'bar']);

function translit(word) {
  let out = '';
  for (const ch of word) out += TRANSLIT[ch] ?? ch;
  return out;
}

/** Strips the provider's "UK: " style prefix, returns { country, rest }. */
function splitPrefix(name) {
  const m = name.match(/^([A-Z]{2,3}):\s*(.*)$/);
  return m ? { country: m[1] === 'UK' ? 'GB' : m[1], rest: m[2] } : { country: null, rest: name };
}

/** Canonical token list. Same function is applied to playlist channel names and EPG team names. */
function tokens(name) {
  const { rest } = splitPrefix(name);
  const cleaned = rest
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim();

  const out = [];
  for (let t of cleaned.split(/\s+/)) {
    if (!t) continue;
    t = CANON[t] ?? t;
    if (/\p{Script=Cyrillic}/u.test(t)) t = CANON[t] ?? translit(t);
    if (STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

function digits(toks) {
  return toks.filter((t) => /^\d+$/.test(t)).sort().join(',');
}

/**
 * 0..100. Numbered feeds are hard-gated: "Sky Sport 1" must never collapse
 * into "Sky Sport 2", which plain fuzzy distance happily does.
 */
function similarity(a, b) {
  return similarityTokens(tokens(a), tokens(b));
}

/**
 * То же самое, но по уже посчитанным токенам. Нужно там, где одну и ту же
 * строку сравнивают с тысячами других: `similarity()` токенизирует ОБЕ
 * стороны на каждый вызов, и сопоставление имён станций с каналами
 * плейлиста упиралось именно в это — два миллиона токенизаций одной и той
 * же тысячи имён каналов.
 *
 * Токены обязаны быть получены из `tokens()` по исходной строке. Взять их
 * из склеенных обратно токенов нельзя: `tokens()` не идемпотентна —
 * «спор» → `spor`, а `spor` → `sport` (турецкое), см. CANON.
 */
function similarityTokens(ta, tb) {
  if (!ta.length || !tb.length) return 0;
  if (digits(ta) !== digits(tb)) return 0;

  const sa = new Set(ta);
  const sb = new Set(tb);
  if (ta.join(' ') === tb.join(' ')) return 100;

  let hits = 0;
  for (const t of sa) if (sb.has(t)) hits++;
  const dice = (200 * hits) / (sa.size + sb.size);

  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  const contained = [...small].every((t) => big.has(t));
  if (contained && small.size >= 2 && big.size - small.size <= 1) return Math.max(dice, 88);

  return dice;
}

module.exports = { tokens, similarity, similarityTokens };
