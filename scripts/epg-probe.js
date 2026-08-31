'use strict';
// Fetches the XMLTV guide and reports what's actually inside it — channel
// overlap with the playlist, categories, and sample football-ish titles.
// Match discovery itself comes from FotMob now (electron/fotmob.js); this is
// exploratory tooling for understanding the feed shape.
//
//   npm run epg                  (uses the feed declared in the playlist)
//   npm run epg -- <url>
//   type epg-sample.log

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'epg-sample.log');
const lines = [];
const say = (t = '') => { lines.push(t); console.log(t); };

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const playlist = require(path.join(ROOT, 'electron', 'playlist.js'));
const epg = require(path.join(ROOT, 'electron', 'epg.js'));
const { attr, tag } = epg;

// Плейлист может быть и ссылкой — с тех пор как это появилось в
// «Настройках», `path.isAbsolute` на "https://…" возвращает false, и путь
// склеивался в бессмыслицу вида `C:\dev\sportcenter\https:\…`. Скрипт при
// этом не падал, а молча терял главную часть отчёта — сверку с каналами
// плейлиста. `playlist.load()` сам различает файл и ссылку.
const plSource = playlist.isUrl(config.playlistPath || '')
  ? config.playlistPath
  : path.isAbsolute(config.playlistPath || '')
    ? config.playlistPath
    : path.join(ROOT, config.playlistPath || 'playlist.m3u8');

const FOOT = /футбол|football|soccer|чемпионат|лига|кубок|премьер|серия a|ла лига|бундеслига/i;

(async () => {
  // Один разбор на весь прогон, через load() — он сам различает файл и
  // ссылку. Раньше плейлист читался дважды и только с диска.
  let parsed = { channels: [], epgUrl: null };
  try {
    parsed = await playlist.load(plSource);
  } catch (err) {
    say(`плейлист не прочитался (${err.message}) — сверка с каналами будет пустой`);
  }
  const url = process.argv[2] || parsed.epgUrl || config.epgUrl;
  if (!url) {
    say('Адрес EPG не найден: ни аргументом, ни в плейлисте, ни в конфиге.');
    return finish();
  }

  say(`пробую ${url}`);
  say('');
  say('=== Источник ===');
  say(url);
  const xmlBuf = await epg.loadXmltv(url);
  say(`распаковано ${(xmlBuf.length / 1048576).toFixed(1)} МБ`);
  const text = xmlBuf.toString('utf8');

  // --- channels ------------------------------------------------------------
  const epgIds = new Set();
  for (const m of text.matchAll(/<channel\s+id="([^"]+)"/g)) epgIds.add(m[1]);

  const channels = parsed.channels;
  const byId = new Map(channels.map((c) => [c.id, c]));

  say('');
  say('=== Каналы ===');
  say(`в EPG: ${epgIds.size}, в плейлисте: ${channels.length}, пересечение: ${channels.filter((c) => epgIds.has(c.id)).length}`);

  const knownIds = new Set(channels.map((c) => c.id).filter(Boolean));

  // --- programmes ----------------------------------------------------------
  say('');
  say('=== Передачи ===');
  let total = 0;
  let onKnown = 0;
  let footish = 0;
  const catCount = new Map();
  const samples = [];
  const separators = new Map();

  for (const m of text.matchAll(/<programme\b([^>]*)>([\s\S]*?)<\/programme>/g)) {
    total++;
    const attrs = m[1];
    const body = m[2];
    const ch = attr(attrs, 'channel');
    if (!knownIds.has(ch)) continue;
    onKnown++;

    const cat = tag(body, 'category');
    if (cat) catCount.set(cat, (catCount.get(cat) || 0) + 1);

    const title = tag(body, 'title');
    if (!title || !FOOT.test(title)) continue;
    footish++;

    for (const sep of [' — ', ' - ', ' – ', ' vs ', ' : ']) {
      if (title.includes(sep)) separators.set(sep, (separators.get(sep) || 0) + 1);
    }

    if (samples.length < 45) {
      samples.push({
        ch,
        name: byId.get(ch)?.name || ch,
        start: attr(attrs, 'start'),
        stop: attr(attrs, 'stop'),
        title,
        desc: tag(body, 'desc').slice(0, 130),
      });
    }
  }

  say(`всего передач: ${total}`);
  say(`на известных (из плейлиста) каналах: ${onKnown}`);
  say(`похожих на футбол (по слову в заголовке): ${footish}`);

  say('');
  say('=== Категории на спортивных каналах ===');
  const cats = [...catCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (!cats.length) say('  категории пустые — отбирать придётся по заголовку');
  for (const [k, v] of cats) say(`  ${String(v).padStart(6)}  ${k}`);

  say('');
  say('=== Разделители команд в заголовках ===');
  if (!separators.size) say('  ни одного из ожидаемых — смотри примеры ниже');
  for (const [k, v] of [...separators.entries()].sort((a, b) => b[1] - a[1])) {
    say(`  ${String(v).padStart(6)}  "${k}"`);
  }

  say('');
  say('=== Примеры заголовков ===');
  for (const s of samples) {
    say(`  ${s.start.slice(0, 12)}  [${s.name}]`);
    say(`      ${s.title}`);
    if (s.desc) say(`      · ${s.desc}`);
  }

  finish();
})().catch((err) => {
  say(`ошибка: ${err.message}`);
  finish();
});

function finish() {
  fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8');
  console.log(`\nотчёт записан в ${LOG}`);
}
