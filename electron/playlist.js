'use strict';
const fs = require('fs');

// Group number -> ISO alpha-2. Groups 1..13 are the provider's Russian block.
const GROUP_COUNTRY = {
  14: 'DE', 15: 'DE', 16: 'PL', 17: 'CZ', 18: 'UA', 19: 'BY', 20: 'ES',
  21: 'IT', 22: 'FR', 23: 'LT', 24: 'LV', 25: 'EE', 26: 'RO', 27: 'MD',
  28: 'GB', 29: 'US', 30: 'CA', 31: 'IL', 32: 'AM', 33: 'GE', 34: 'KZ',
  35: 'UZ', 36: 'KG', 37: 'AZ', 38: 'TR',
};

// Name prefixes the provider uses ("UK: Sky Sports ..."). Some are not ISO.
const PREFIX_COUNTRY = { UK: 'GB', INT: null, SR: 'RS' };

const ATTR = /([\w-]+)="([^"]*)"/g;

/** The playlist declares its own EPG feed in the #EXTM3U header. */
function epgUrlFrom(header) {
  const m = header.match(/(?:url-tvg|x-tvg-url|tvg-url)="([^"]*)"/);
  if (!m) return null;
  // The attribute may list several comma-separated feeds; the first wins.
  return m[1].split(',')[0].trim() || null;
}

function attrs(line) {
  const out = {};
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(line)) !== null) out[m[1]] = m[2];
  return out;
}

/** Quality tier used to pick one stream when several carry the same channel. */
function quality(name) {
  const n = name.toLowerCase();
  let score = 2; // unmarked streams are usually HD on this provider
  if (/\b(uhd|4k)\b/.test(n)) score = 4;
  else if (/\bfhd\b/.test(n)) score = 3.5;
  else if (/\bhd\b/.test(n)) score = 3;
  else if (/\bsd\b/.test(n)) score = 1;
  if (/\bhdr\b/.test(n)) score += 0.3;
  if (/50fps/.test(n)) score += 0.2;
  if (/\bdouble\b|\bbackup\b|\brez\b/.test(n)) score -= 1.5; // mirror feeds, keep as fallback
  if (/\+\d+\b/.test(n)) score -= 3; // "+2", "+4" are timezone shifts, not the live feed
  return score;
}

/** @returns { channels, epgUrl } */
function parseText(text) {
  const channels = [];
  let epgUrl = null;
  let pending = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      epgUrl = epgUrlFrom(line);
    } else if (line.startsWith('#EXTINF')) {
      const a = attrs(line);
      const title = line.includes(',') ? line.slice(line.indexOf(',') + 1).trim() : '';
      const name = a['tvg-name'] || title;
      pending = {
        id: a['tvg-id'] || null,
        name,
        logo: a['tvg-logo'] || null,
        quality: quality(name),
        // group-title is the standard place most providers put this; the
        // current one instead uses a separate #EXTGRP line below, which —
        // when present — overrides this as more specific/dedicated info.
        group: a['group-title'] || null,
      };
    } else if (line.startsWith('#EXTGRP:') && pending) {
      pending.group = line.slice(8).trim();
    } else if (!line.startsWith('#') && pending) {
      pending.url = line;

      const gNum = Number((pending.group || '').match(/^(\d+)\./)?.[1]);
      const prefix = pending.name.match(/^([A-Z]{2,3}):\s/)?.[1];
      let country = null;
      if (prefix) {
        country = prefix in PREFIX_COUNTRY ? PREFIX_COUNTRY[prefix] : prefix;
      } else if (gNum) {
        country = gNum <= 13 ? 'RU' : (GROUP_COUNTRY[gNum] ?? null);
      }
      pending.country = country;

      channels.push(pending);
      pending = null;
    }
  }

  return { channels, epgUrl };
}

const isUrl = (source) => /^https?:\/\//i.test(source);

/**
 * Playlist source can be a local file path or an http(s) URL — the provider
 * link works exactly like the EPG feed's own URL (see epg.js), just for the
 * channel list instead of the programme guide. No disk cache here, unlike
 * EPG: an M3U file is a lot smaller than the XMLTV feed, and this already
 * gets re-read from scratch every sync for local files too — fetching a
 * fresh copy each time is the same cost class, not a new one.
 */
async function load(source) {
  if (isUrl(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${source}`);
    return parseText(await res.text());
  }
  return parseText(fs.readFileSync(source, 'utf8'));
}

module.exports = { load, parseText, isUrl };
