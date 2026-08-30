'use strict';

// Общий вызов к недокументированному JSON-API FotMob. Раньше этот блок —
// User-Agent, выбор fetch и разбор ответа — лежал одинаковым копипастом в
// fotmob.js и broadcasters.js; таймаут понадобился обоим, и держать его в
// двух местах было бы третьей копией.
//
// Ключей и аккаунта эти эндпоинты не требуют, но идти к ним надо через стек
// Chromium (`electron.net.fetch`): обычный Node-fetch с того же хоста
// блокируется — тот же класс защиты, что у Sofascore/TheSportsDB.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Синк дёргает под сорок турниров и столько же стран подряд. Один
// подвисший запрос без таймаута вешал бы весь синк молча и навсегда:
// кнопка «Обновить» заблокирована, отменить нечем. Лучше уронить один
// турнир — вызывающая сторона это переживает и идёт дальше.
const TIMEOUT_MS = 20000;

function pickFetch() {
  try {
    const { net } = require('electron');
    if (net?.fetch) return net.fetch.bind(net);
  } catch { /* not running inside Electron */ }
  return globalThis.fetch;
}

/**
 * GET + JSON. `label` попадает в текст ошибки — по нему в строке прогресса
 * видно, какой именно турнир или страна отвалились.
 */
async function fetchJson(url, label, timeoutMs = TIMEOUT_MS) {
  const res = await pickFetch()(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.fotmob.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${label}`);
  return res.json();
}

module.exports = { fetchJson };
