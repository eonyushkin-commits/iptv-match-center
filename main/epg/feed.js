'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('../store');

const TTL_MS = 6 * 3600 * 1000;

// Файлы кэша разведены ПО URL, а не по фиксированному имени: иначе смена
// EPG-провайдера в пределах TTL молча отдавала бы прежний фид — тот же файл,
// формально свежий, но с чужой схемой channel id, и сетка оказывалась пустой
// без единой ошибки. Ловилось живьём на смене провайдера.
function cachePath(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  return path.join(store.root, `epg-${hash}.xml.gz`);
}

/** Достаёт байты первого обычного файла из tar: у части провайдеров фид —
 * это gzip-сжатый tar с одним XML внутри, а не gzip-сжатый XML. Библиотека
 * ради «достать один файл из одного архива» не нужна. Формат определяется по
 * содержимому, а не по расширению в ссылке. */
function untar(buf) {
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // конец архива
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*/s, '').trim(), 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;
    if ((typeFlag === '0' || typeFlag === '\0') && size > 0) return buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512; // содержимое дополнено до 512 байт
  }
  return null;
}

/**
 * Кэш всегда хранит gzip-байты, чем бы ни был исходный файл (голый XML
 * пережимается перед записью), поэтому отсюда до содержимого один шаг: либо
 * это сразу XML, либо tar с ним внутри — различаются по первому байту.
 *
 * Распаковка асинхронная: `gunzipSync` на 30 МБ раскрывается в 200 с лишним
 * и занимает поток на треть секунды.
 *
 * @returns Buffer — намеренно не строка: фид бывает за 200 МБ, а из-за
 *   кириллицы V8 держал бы строку по два байта на символ.
 */
async function unpack(gz) {
  const decompressed = await new Promise((resolve, reject) => {
    zlib.gunzip(gz, (err, out) => (err ? reject(err) : resolve(out)));
  });
  const xml = decompressed[0] === 0x3c /* '<' */ ? decompressed : untar(decompressed);
  if (!xml) throw new Error('Не удалось распаковать EPG-фид (неизвестный формат архива)');
  return xml;
}

// Обрыв по ПРОСТОЮ, а не по общему времени закачки. Таймаут на всю операцию
// был бы отсечкой по скорости, а не защитой от зависания: фид весит десятки
// мегабайт, и на медленном канале синк падал бы каждый раз, никогда не
// доезжая. Таймер сбрасывается на каждом пришедшем куске.
const STALL_MS = 45000;

/** @returns Buffer */
async function fetchWithStallTimeout(url, stallMs = STALL_MS) {
  // Свой контроллер, а не AbortSignal.timeout: тот остаётся активным на всё
  // время чтения тела, то есть снова превращается в таймаут на всю закачку.
  // В предыдущем проекте первая версия этой функции падала ровно так, и это
  // поймал тест, а не живой прогон.
  const controller = new AbortController();
  const headerTimer = setTimeout(
    () => controller.abort(new Error(`EPG-фид не отвечает ${Math.round(stallMs / 1000)} с: ${url}`)),
    stallMs,
  );
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);

  const reader = res.body.getReader();
  const chunks = [];
  try {
    for (;;) {
      let timer;
      const stalled = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`EPG-фид молчит дольше ${Math.round(stallMs / 1000)} с: ${url}`)), stallMs);
      });
      const { done, value } = await Promise.race([reader.read(), stalled])
        .finally(() => clearTimeout(timer));
      if (done) break;
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => { /* соединение уже мертво */ });
    throw err;
  }
  return Buffer.concat(chunks);
}

/** Протухшие файлы чужих провайдеров — иначе копятся навсегда: у автора
 * предыдущего проекта набралось 170 МБ от четырёх источников. */
function pruneCache(keep) {
  let names;
  try {
    names = fs.readdirSync(store.root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^epg-[0-9a-f]+\.xml\.gz$/.test(name)) continue;
    const p = path.join(store.root, name);
    if (p === keep) continue;
    try {
      if (Date.now() - fs.statSync(p).mtimeMs >= TTL_MS) fs.unlinkSync(p);
    } catch { /* исчез сам или занят — не наша забота */ }
  }
}

/**
 * Скачанный фид плюс его ВЕРСИЯ — то, чего не было в предыдущем проекте и
 * ради чего здесь всё переписано. Версия («когда этот файл появился на
 * диске») позволяет всему, что стоит дальше, спросить «фид тот же?» и не
 * делать работу заново. Раньше конвейер разбирал 213 МБ XML на каждый синк,
 * то есть шесть раз подряд в течение одного TTL, ради ровно одного и того же
 * результата.
 *
 * @returns { xml: Buffer, version: string, fromCache: boolean }
 */
async function load(url) {
  const file = cachePath(url);
  // На каждом заходе, а не только после закачки: пока текущий фид свежий,
  // закачки не происходит вовсе — и чужие протухшие файлы лежали бы до
  // ближайшего обновления.
  pruneCache(file);

  if (fs.existsSync(file)) {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < TTL_MS) {
      try {
        return { xml: await unpack(fs.readFileSync(file)), version: String(stat.mtimeMs), fromCache: true };
      } catch {
        // Битый файл (оборвалась запись, кончилось место) держал бы синк
        // мёртвым все шесть часов TTL: mtime свежий, перекачки не будет, а
        // распаковка падает на каждом заходе. Выкидываем и качаем заново.
        try { fs.unlinkSync(file); } catch { /* уже нет */ }
      }
    }
  }

  const buf = await fetchWithStallTimeout(url);
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  const gz = isGz ? buf : zlib.gzipSync(buf);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gz);
  return { xml: await unpack(gz), version: String(fs.statSync(file).mtimeMs), fromCache: false };
}

/** Версия фида без его скачивания — по ней sync решает, нужен ли фид вообще.
 * `null`, если кэша нет или он протух. */
function cachedVersion(url) {
  try {
    const stat = fs.statSync(cachePath(url));
    return Date.now() - stat.mtimeMs < TTL_MS ? String(stat.mtimeMs) : null;
  } catch {
    return null;
  }
}

module.exports = { load, cachedVersion, cachePath, fetchWithStallTimeout, TTL_MS };
