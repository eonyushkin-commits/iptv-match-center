'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tokens, similarity } = require('./normalize');
const { firstAtOrAfter } = require('./epg/index');

/**
 * Отпечаток самого сопоставления: исходники, которые решают, что с чем
 * совпадает, плюс словарь имён.
 *
 * Кэш связей нельзя привязывать к одним лишь ДАННЫМ (фид, набор каналов):
 * результат зависит ещё и от того, ЧЕМ он посчитан. Поймано дважды живьём.
 *
 * Раз: исправление нечёткого сравнения не убрало из ленты ложный канал Disney
 * — кэш признал себя годным, ведь фид не менялся, — и правка вступила бы в
 * силу лишь через шесть часов, при следующей перекачке.
 *
 * Два, и это хуже: правка `teams.json` не влияла ни на что по той же причине.
 * То есть главная идея словаря — «имена команд это данные, добавил клуб и
 * сразу работает, без выпуска новой версии» — молча работала вхолостую.
 *
 * Считается по СОДЕРЖИМОМУ файлов, а не номером версии, который надо помнить
 * и поднимать руками: за один вечер я забыл это сделать дважды. Чтение своих
 * же исходников работает и из app.asar; стоит один раз за запуск.
 */
let sourceHash = null;
function matcherKey(aliases) {
  if (sourceHash === null) {
    const h = crypto.createHash('sha1');
    // Оба файла целиком определяют исход: link.js — правила, normalize.js —
    // канонизацию и транслитерацию, на которой эти правила стоят.
    for (const f of [__filename, path.join(__dirname, 'normalize.js')]) {
      try {
        h.update(fs.readFileSync(f));
      } catch {
        // Прочитать себя не вышло — берём заведомо неповторимое значение,
        // чтобы кэш считался негодным. Лишний пересчёт дешевле молчаливой
        // ошибки: именно молчаливость и была тут главной бедой.
        h.update(`нечитаемо-${Date.now()}-${Math.random()}`);
      }
    }
    sourceHash = h.digest('hex').slice(0, 12);
  }
  // Словарь сериализуем по отсортированным ключам: порядок в объекте не
  // должен менять отпечаток, иначе кэш будет сбрасываться на ровном месте.
  const stable = JSON.stringify(Object.keys(aliases || {}).sort().map((k) => [k, aliases[k]]));
  return crypto.createHash('sha1').update(sourceHash + stable).digest('hex').slice(0, 16);
}

const WINDOW_MS = 90 * 60 * 1000;
const TEAM_THRESHOLD = 78;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** «Málaga» -> «malaga», «Beşiktaş» -> «besiktas». Разложение по Unicode и
 * снятие комбинирующих знаков — единственное расхождение, которое бывает
 * между латинским заголовком и латинским же именем команды. */
const foldDiacritics = (s) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Классическое редакционное расстояние — строки короткие, сложнее не нужно. */
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

// Короткие клубные аббревиатуры, общие у десятков клубов («Toronto FC», «New
// York City FC») и притом встречающиеся вне футбола вовсе. Сами по себе клуб
// не опознают: голое «fc» в заголовке «Bare Knuckle FC» (бокс) когда-то
// построило карточку Toronto FC–NYCFC на канале, где матча не было.
//
// Длинные квалификаторы («United», «City», «Athletic», «Real») сюда
// намеренно НЕ входят: без них ломается целый класс валидных совпадений.
// Слово, общее с СОПЕРНИКОМ по этой же паре, вычитается отдельно, ниже.
//
// «wanderers» и «west» добавлены по живым ложным срабатываниям, которых
// вычитание соперника не ловит по конструкции: там коллизия была с ТРЕТЬИМ,
// посторонним матчем («Bolton Wanderers» поймал «Wolverhampton Wanderers vs
// Stoke City», «West Ham United» поймал «West Bromwich Albion»).
const GENERIC_TEAM_TOKENS = new Set(['fc', 'cf', 'sc', 'afc', 'cfc', 'fk', 'ac', 'sk', 'wanderers', 'west']);

/**
 * Токены, по которым стоит искать одну сторону: свои, минус глобально общие
 * и минус всё, что есть у соперника. Вторая часть важна и для слов, которые
 * сами по себе не общие: «Cardiff City» против «Norwich City» делят «city», и
 * требование одного совпавшего токена на сторону означало, что заголовок с
 * голым «city» (мультфильм, travel-шоу) удовлетворяет ОБЕ стороны разом.
 */
function meaningfulTeamTokens(teamTokens, opponentTokens) {
  const opponentSet = new Set(opponentTokens);
  const withoutGeneric = teamTokens.filter((t) => !GENERIC_TEAM_TOKENS.has(t));
  const distinctive = withoutGeneric.filter((t) => !opponentSet.has(t));
  if (distinctive.length) return distinctive;
  if (withoutGeneric.length) return withoutGeneric;
  return teamTokens;
}

/**
 * Похоже ли, что эта команда названа в заголовке.
 *
 * @returns null, если нет; иначе `{ exact }` — совпало ли ТОЧНО по токену.
 *   Неточное совпадение (нечёткая ветка) вызывающая сторона записывает в
 *   кандидаты словаря: в новой модели нечёткость не решение, а предложение.
 */
function teamInTitle(meaningfulTokens, titleTokenSet, fullTokens, titleWasCyrillic) {
  if (!meaningfulTokens.length) return null;

  // Одного совпавшего слова достаточно: город — наименее надёжная часть
  // имени, он транслитерируется непредсказуемо («Москва» -> moskva, а не
  // moscow) и часто стоит в скобках, которые токенизатор срезает. Требование
  // большего обнуляло всю РПЛ целиком.
  for (const t of meaningfulTokens) if (titleTokenSet.has(t)) return { exact: true, via: t };

  // Заголовок НА ЛАТИНИЦЕ: расхождение бывает ровно одного рода — потерянная
  // диакритика («Malaga» за «Málaga», «Besiktas» за «Beşiktaş», «Koln» за
  // «Köln»). Поэтому сравниваем не по расстоянию, а точно, свернув диакритику.
  //
  // Здесь стоял Левенштейн, суженный до слов ТОЙ ЖЕ длины и допуска
  // floor(длина/3). Сужения не хватило: у шестибуквенного слова допуск равен
  // двум, а две замены из шести — это треть слова, а не шум. Живое ложное
  // срабатывание: мультфильм «Big City Greens» на Disney построил карточку
  // QPR – Cardiff City. «Greens» сошлось с «Queens» (две замены при длине 6),
  // а «Cardiff City» удовлетворилось голым «city» из того же заголовка.
  // Сворачивание диакритики отсекает queens/greens и сохраняет все три
  // настоящих случая — проверено на них поимённо.
  if (!titleWasCyrillic) {
    // Порога длины здесь нет намеренно, в отличие от ветки ниже. Он нужен
    // Левенштейну: у короткого слова любая допустимая правка съедает слишком
    // большую его долю. Точному сравнению он только мешал — «Köln» это
    // четыре буквы, и порог 5 отсекал совершенно законное «Koln» в
    // заголовке. Совпасть после сворачивания диакритики два несвязанных
    // слова не могут: свёртка меняет только надстрочные знаки.
    for (const t of meaningfulTokens) {
      for (const titleToken of titleTokenSet) {
        if (titleToken.length !== t.length) continue;
        if (foldDiacritics(titleToken) === foldDiacritics(t)) return { exact: false, via: titleToken };
      }
    }
  } else {
    // Заголовок НА КИРИЛЛИЦЕ: здесь шум настоящий и обильный, потому что
    // транслитерация посимвольная, а не официальная романизация:
    // «Барселона» -> barselona против Barcelona, «Ювентус» -> yuventus против
    // Juventus. Допуск плавающий (~1 правка на 3 символа): плоский «<= 2»
    // слишком широк для коротких слов — «Lille» (5) и посторонний «Silent
    // Hill» тоже в двух правках, и это ловилось живьём.
    for (const t of meaningfulTokens) {
      if (t.length < 5) continue;
      const maxDist = Math.floor(t.length / 3);
      for (const titleToken of titleTokenSet) {
        if (Math.abs(titleToken.length - t.length) > 2) continue;
        if (levenshtein(t, titleToken) <= maxDist) return { exact: false, via: titleToken };
      }
    }
  }

  if (similarity(fullTokens.join(' '), [...titleTokenSet].join(' ')) >= TEAM_THRESHOLD) {
    return { exact: false, via: null };
  }
  return null;
}

// Токены заголовка и его алфавит — по первому обращению, дальше с самой
// передачи: сопоставление зовётся для каждого матча и иначе токенизировало бы
// одни и те же заголовки по кругу. `cyr` считается по СЫРОМУ заголовку: к
// моменту токенизации всё уже латиница, а нечёткая ветка зависит именно от
// исходного алфавита.
const titleTokens = (p) => (p._tok ??= new Set(tokens(p.title)));
const titleIsCyrillic = (p) => (p._cyr ??= CYRILLIC.test(p.title));

/**
 * Какие каналы несут этот матч по данным EPG.
 *
 * Отличие от предыдущего проекта: возвращается не список id, а улика на
 * каждый канал — какая передача и в какое время его подтвердила. Раньше
 * происхождение связи стиралось сразу после сопоставления, и на вопрос
 * «почему этот канал в карточке» нельзя было ответить, не прогнав весь
 * матчер заново. Именно это и пришлось делать при живом разборе ошибки.
 *
 * @returns [{ channelId, title, start, stop, exact }]
 * @param candidates Map, куда складываются нечёткие попадания (см. teams.js)
 */
function fromEpg(programmes, fixture, forms, candidates = new Map()) {
  const homeForms = forms.home.map((f) => ({ form: f, tokens: tokens(f) })).filter((f) => f.tokens.length);
  const awayForms = forms.away.map((f) => ({ form: f, tokens: tokens(f) })).filter((f) => f.tokens.length);
  if (!homeForms.length || !awayForms.length) return [];

  // Пул соперника — из ВСЕХ его форм, чтобы слово, общее с любой из них,
  // тоже вычиталось.
  const homePool = homeForms.flatMap((f) => f.tokens);
  const awayPool = awayForms.flatMap((f) => f.tokens);
  for (const f of homeForms) f.meaningful = meaningfulTeamTokens(f.tokens, awayPool);
  for (const f of awayForms) f.meaningful = meaningfulTeamTokens(f.tokens, homePool);

  const lo = fixture.start - WINDOW_MS;
  const hi = fixture.start + WINDOW_MS;
  const best = new Map(); // channelId -> улика

  const hit = (formList, tt, cyr) => {
    for (const f of formList) {
      const r = teamInTitle(f.meaningful, tt, f.tokens, cyr);
      if (r) return r;
    }
    return null;
  };

  for (let i = firstAtOrAfter(programmes, lo); i < programmes.length; i++) {
    const p = programmes[i];
    if (p.start > hi) break; // отсортировано по началу — дальше нечему совпасть
    const tt = titleTokens(p);
    const cyr = titleIsCyrillic(p);
    const h = hit(homeForms, tt, cyr);
    if (!h) continue;
    const a = hit(awayForms, tt, cyr);
    if (!a) continue;

    // Нечёткое попадание — повод предложить алиас, а не молча закрепить его
    // в коде на следующий релиз.
    for (const [side, r] of [[fixture.home, h], [fixture.away, a]]) {
      if (r.exact || !r.via) continue;
      if (!candidates.has(side)) candidates.set(side, new Set());
      candidates.get(side).add(r.via);
    }

    const evidence = {
      channelId: p.channelId,
      title: p.title,
      start: p.start,
      stop: p.stop,
      exact: h.exact && a.exact,
    };
    // На одном канале в окне бывает несколько подходящих передач (анонс,
    // сам матч, обзор) — держим ту, что ближе к свистку.
    const prev = best.get(p.channelId);
    if (!prev || Math.abs(p.start - fixture.start) < Math.abs(prev.start - fixture.start)) {
      best.set(p.channelId, evidence);
    }
  }

  return [...best.values()];
}

// Виды спорта, которые в заголовке названы достаточно прямо, чтобы закрыть
// вопрос. Используется ТОЛЬКО чтобы отвергнуть заявку вещателя: тот источник
// отвечает на уровне правообладателя и спокойно называет канал, которого в
// эфире не было — ловилось живьём на автоспорте и баскетболе ровно в слоте
// свистка. Обычным поиском по заголовкам не используется: там заголовок и
// так обязан назвать обе команды, чего листинг другого спорта не сделает.
//
// Границы через lookaround, НЕ `\b`: в JavaScript `\b` определён через
// ASCII-\w, поэтому у кириллического слова границ нет вовсе и `\bавтоспорт\b`
// молча не срабатывает никогда — весь guard тихо ничего не делал, пока живой
// прогон не показал автоспорт, всё ещё проходящий насквозь.
const OTHER_SPORTS = /(?<!\p{L})(баскетбол|хоккей|теннис|волейбол|гандбол|автоспорт|мотоспорт|биатлон|бокс|регби|гольф|крикет|дартс|снукер|формула|хокей|siatkówka|siatkowka|koszykówka|koszykowka|hokej|żużel|zuzel|tenis|volleyball|basketball|eishockey|handball|volei|baschet|hochei|handbal|pallavolo|pallamano|basket|voleibol|baloncesto|balonmano|basquetebol|hóquei|hoquei|andebol|ténis|voleybol|basketbol|hentbol|hokey|volejbal|basketbal|házená|hazena|volleybal|ijshockey|volleyboll|ishockey|handboll|hockey|tennis|motorsport|biathlon|boxing|rugby|golf|cricket|darts|snooker|nba|nhl|mlb|ufc)(?!\p{L})/iu;

const isOtherSport = (title) => OTHER_SPORTS.test(title);

module.exports = {
  fromEpg,
  isOtherSport,
  meaningfulTeamTokens,
  teamInTitle,
  levenshtein,
  matcherKey,
  WINDOW_MS,
  GENERIC_TEAM_TOKENS,
};
