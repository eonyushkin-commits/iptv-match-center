'use strict';
// Регрессия на сопоставление матчей с передачами EPG — самая калиброванная и
// самая хрупкая часть проекта: 6 из первых 22 коммитов чинили именно её, и
// каждый раз проверка была разовым скриптом, который потом выбрасывался.
// Здесь тот же набор кейсов, но постоянный: каждый негативный случай —
// реальное ложное срабатывание, пойманное на живых данных (см. CLAUDE.md),
// каждый позитивный — реальная трансляция, которая должна находиться.
//
// Сети и диска не касается: `findBroadcastChannels` работает с готовым
// списком передач, `programmes` — со строкой XML.
//
//   npm test
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { findBroadcastChannels, programmes, isOtherSport } = require('../electron/epg');
const { similarity, similarityTokens, tokens } = require('../electron/normalize');

const KICKOFF = Date.UTC(2026, 7, 30, 18, 0, 0);

/** Один канал, одна передача со сдвигом от стартового свистка. */
function slot(title, offsetMin = 0) {
  const start = KICKOFF + offsetMin * 60000;
  return [{ channelId: 'ch1', title, start, stop: start + 120 * 60000 }];
}

/** Нашёлся ли канал для этой пары команд по этому заголовку. */
function finds(home, away, homeShort, awayShort, title, offsetMin = 0) {
  return findBroadcastChannels(slot(title, offsetMin), home, away, KICKOFF, homeShort, awayShort).length > 0;
}

describe('findBroadcastChannels: находит настоящие трансляции', () => {
  const cases = [
    ['точное совпадение на латинице',
      'Tottenham Hotspur', 'Newcastle United', 'Tottenham', 'Newcastle',
      'Saturday Night Football. Tottenham Hotspur v Newcastle United'],
    ['транслитерация кириллицы (Барселона ~ Barcelona, 1 правка)',
      'Barcelona', 'Athletic Club', 'Barcelona', 'Athletic',
      '⋗ Футбол. Испания. Барселона – Атлетик'],
    ['транслитерация с расхождением ю в yu (Ювентус ~ Juventus)',
      'Juventus', 'Milan', 'Juventus', 'Milan',
      '⋗ Футбол. Италия. Ювентус – Милан'],
    ['город в имени не нужен (Зенит, а не Zenit St Petersburg)',
      'Zenit St Petersburg', 'Spartak Moscow', 'Zenit', 'Spartak',
      '⋗ Футбол. Россия. Зенит – Спартак'],
    ['короткое имя от FotMob (Lille – PSG, не Paris Saint-Germain)',
      'Lille', 'Paris Saint-Germain', 'Lille', 'PSG',
      'Football: Lille - PSG'],
    ['словарь RU_NICKNAMES: переведённый экзоним (Бавария)',
      'Bayern München', 'VfB Stuttgart', 'Bayern', 'Stuttgart',
      '⋗ Футбол. Германия. Бавария – Штутгарт'],
    ['словарь RU_NICKNAMES: транслит произношения (Гоу Эхед Иглс)',
      'AZ Alkmaar', 'Go Ahead Eagles', 'AZ', 'Go Ahead',
      '⋗ Футбол. Нидерланды. АЗ Алкмаар – Гоу Эхед Иглс'],
    ['словарь RU_NICKNAMES: диакритика (Бешикташ)',
      'Beşiktaş', 'Fenerbahçe', 'Beşiktaş', 'Fenerbahçe',
      '⋗ Футбол. Турция. Бешикташ – Фенербахче'],
    ['потерянная диакритика на латинице — замена буквы, длина та же',
      'Real Madrid', 'Málaga', 'Real Madrid', 'Malaga',
      'Real Madrid - Malaga'],
    ['«Юнайтед» как единственный мост, когда соперник его не несёт',
      'Newcastle United', 'Tottenham Hotspur', 'Newcastle', 'Tottenham',
      '⋗ Футбол. Ньюкасл Юнайтед – Тоттенхэм'],
  ];

  for (const [label, home, away, hs, as, title] of cases) {
    test(label, () => assert.ok(finds(home, away, hs, as, title), `не найдено: ${title}`));
  }
});

describe('findBroadcastChannels: не ловит чужое', () => {
  const cases = [
    ['общая клубная аббревиатура «FC» с обеих сторон (было: бокс на карточке Toronto FC)',
      'Toronto FC', 'New York City FC', 'Toronto', 'NYCFC',
      '⋗ Бокс. Bare Knuckle FC. Трансляция из США'],
    ['слово, общее с соперником по паре — «City» (было: 17 каналов с мультиками)',
      'Cardiff City', 'Norwich City', 'Cardiff', 'Norwich',
      'LEGO City. Мультсериал'],
    ['то же, другой заголовок с двумя «city»',
      'Cardiff City', 'Norwich City', 'Cardiff', 'Norwich',
      'City Breaks: Big City Greens'],
    ['коллизия с ТРЕТЬИМ матчем: «Wanderers» + «City» (было: Bolton на матче Вулверхэмптона)',
      'Bolton Wanderers', 'Lincoln City', 'Bolton', 'Lincoln',
      'Wolverhampton Wanderers vs. Stoke City'],
    ['то же по-русски',
      'Bolton Wanderers', 'Lincoln City', 'Bolton', 'Lincoln',
      '⋗ Футбол. Англия. Вулверхэмптон – Сток Сити'],
    ['два случайных совпадения по Левенштейну на латинице (было: Nat Geo на карточке РПЛ)',
      'Rodina', 'Baltika', 'Rodina', 'Baltika',
      'Malika: la reina leona'],
    ['короткие имена на латинице не ловятся нечётко (было: Lille ~ Killer)',
      'Lille', 'Paris Saint-Germain', 'Lille', 'PSG',
      'Killer Instinct: Park Life'],
    ['коллизия с ТРЕТЬИМ матчем по слову «West» (было: 3 канала с матчем Вест Бромвича)',
      'Newcastle United', 'West Ham United', 'Newcastle', 'West Ham',
      'Newcastle United - West Bromwich Albion'],
  ];

  for (const [label, home, away, hs, as, title] of cases) {
    test(label, () => assert.ok(!finds(home, away, hs, as, title), `ложное срабатывание: ${title}`));
  }
});

describe('findBroadcastChannels: окно ±90 минут вокруг свистка', () => {
  const pair = ['Tottenham Hotspur', 'Newcastle United', 'Tottenham', 'Newcastle',
    'Football. Tottenham Hotspur v Newcastle United'];

  test('за 89 минут до свистка — находит', () => assert.ok(finds(...pair, -89)));
  test('через 89 минут после свистка — находит', () => assert.ok(finds(...pair, 89)));
  test('за 3 часа до свистка — не находит', () => assert.ok(!finds(...pair, -180)));
  test('через 3 часа после свистка — не находит', () => assert.ok(!finds(...pair, 180)));
});

// Разрыв, который нашли эти самые тесты (и который до них значился в
// CLAUDE.md как заведомо работающий): слово, единственное способное связать
// имя команды с заголовком, отбирает у неё СОБСТВЕННЫЙ соперник. Закрыт
// двумя записями в RU_NICKNAMES — тесты держат обе.
describe('findBroadcastChannels: общий с соперником токен', () => {
  // «Ньюкасл» → nyukasl, до «newcastle» 5 правок при допуске 3, так что
  // мостом работает только «Юнайтед» — а meaningfulTeamTokens() вычитает
  // его как общий с соперником. У «Вест Хэм» токены vest/hem короче порога
  // длины 5 и до Левенштейн-ветки не доходят вовсе. Без словаря не
  // находилась ни одна сторона.
  test('оба клуба несут «Юнайтед» — спасает словарь', () => {
    assert.ok(finds('Newcastle United', 'West Ham United', 'Newcastle', 'West Ham',
      '⋗ Футбол. Англия. Ньюкасл Юнайтед – Вест Хэм Юнайтед'));
  });

  // Вещатель пишет короткое русское имя без «Юнайтед» — в живом EPG таких
  // заголовков было 3 из 16 упоминаний Ньюкасла.
  test('«Тоттенхэм – Ньюкасл»: короткое русское имя без «Юнайтед»', () => {
    assert.ok(finds('Newcastle United', 'Tottenham Hotspur', 'Newcastle', 'Tottenham',
      '⋗ Футбол. АПЛ, 2 тур, Тоттенхэм – Ньюкасл'));
  });

  // Словарь не должен становиться новым источником ложных срабатываний:
  // vest/hem — короткие и участвуют только в точном совпадении, но само по
  // себе «Вест» встречается и вне футбола.
  test('«Вест» в постороннем заголовке не тянет за собой матч', () => {
    assert.ok(!finds('Newcastle United', 'West Ham United', 'Newcastle', 'West Ham',
      '⋗ Дикий Вест. Документальный фильм о Индии'));
  });
});

describe('isOtherSport: явно другой вид спорта в заголовке', () => {
  const other = [
    'Автоспорт. Российская серия кольцевых гонок',
    'Швеция – Франция. Баскетбол',
    'Siatkówka kobiet: Polska - Serbia',
    'Eishockey: Berlin - München',
    'NBA. Lakers - Celtics',
  ];
  const football = [
    '⋗ Футбол. Англия. Челси – Арсенал',
    'Saturday Night Football. Tottenham v Newcastle',
  ];

  for (const t of other) test(`другой спорт: ${t}`, () => assert.ok(isOtherSport(t)));
  for (const t of football) test(`футбол не помечается: ${t}`, () => assert.ok(!isOtherSport(t)));
});

describe('normalize: сравнение имён каналов', () => {
  test('номер канала — жёсткий гейт, 1 не схлопывается в 2', () => {
    assert.strictEqual(similarity('Sky Sports 1', 'Sky Sports 2'), 0);
  });

  test('маркеры качества отбрасываются, канал тот же', () => {
    assert.strictEqual(similarity('Sky Sports Main Event', 'UK: Sky Sports Main Event UHD'), 100);
  });

  // Почему broadcasters.js требует ровно 100, а не порог 78: без номера в
  // имени «Sky Sports UHD» схлопывается в голое «sky sports» и набирает
  // высокий балл против ЧУЖОГО канала — поймано живьём.
  test('«Sky Sports UHD» не должен становиться «Sky Sports News HD»', () => {
    assert.notStrictEqual(similarity('Sky Sports UHD', 'UK: Sky Sports News HD'), 100);
  });

  test('русское и латинское написание сходятся к одним токенам', () => {
    assert.deepStrictEqual(tokens('Матч ТВ'), tokens('Match TV'));
  });

  // similarityTokens() существует ради сопоставления имён станций с тысячей
  // каналов: там токены канала считаются один раз, а не заново на каждую
  // станцию (980 → 116 мс). Инвариант, который это делает безопасным.
  test('similarityTokens по готовым токенам даёт то же, что similarity по строкам', () => {
    const pairs = [
      ['Sky Sports Main Event', 'UK: Sky Sports Main Event UHD'],
      ['Sky Sports 1', 'Sky Sports 2'],
      ['Sky Sports UHD', 'UK: Sky Sports News HD'],
      ['Матч ТВ', 'Матч! Футбол 1 HD'],
      ['', 'Что угодно HD'],
    ];
    for (const [a, b] of pairs) {
      assert.strictEqual(similarityTokens(tokens(a), tokens(b)), similarity(a, b), `${a} / ${b}`);
    }
  });
});

describe('programmes: разбор XMLTV', () => {
  const xml = `<tv>
    <programme start="20260830180000 +0300" stop="20260830200000 +0300" channel="ch1">
      <title lang="ru">Футбол. &#34;Эльче&#34; – Барселона</title>
    </programme>
    <programme channel="ch2" start="20260830140000 +0000">
      <title>Без атрибута stop</title>
    </programme>
    <programme start="20260830120000 +0000" channel="ch-unknown">
      <title>Канала нет в плейлисте</title>
    </programme>
  </tv>`;
  const channels = [{ id: 'ch1' }, { id: 'ch2' }, { id: 'ch3' }];
  const { list, channelCount } = programmes(xml, channels);

  test('передачи с неизвестных каналов отбрасываются', () => {
    assert.strictEqual(list.length, 2);
    assert.ok(!list.some((p) => p.channelId === 'ch-unknown'));
  });

  test('channelCount — сколько каналов плейлиста вообще сканировалось', () => {
    assert.strictEqual(channelCount, 3);
  });

  test('отсортировано по времени начала', () => {
    assert.deepStrictEqual(list.map((p) => p.channelId), ['ch2', 'ch1']);
  });

  test('атрибуты читаются по имени, а не по порядку', () => {
    assert.strictEqual(list[0].start, Date.UTC(2026, 7, 30, 14, 0, 0));
  });

  test('часовой пояс из фида применён', () => {
    assert.strictEqual(list[1].start, Date.UTC(2026, 7, 30, 15, 0, 0));
  });

  test('stop разобран, где есть, и null, где нет', () => {
    assert.strictEqual(list[1].stop, Date.UTC(2026, 7, 30, 17, 0, 0));
    assert.strictEqual(list[0].stop, null);
  });

  // Неразобранная сущность оставила бы в заголовке «34», а это цифровой
  // токен — similarity() жёстко режет пары с несовпадающими цифрами.
  test('XML-сущности декодированы', () => {
    assert.strictEqual(list[1].title, 'Футбол. "Эльче" – Барселона');
    assert.ok(!tokens(list[1].title).includes('34'));
  });
});

// Разбор идёт по байтам, а не по строке (чтобы не держать в памяти
// 250-мегабайтную UTF-16 копию фида). Срезы буфера считаются в байтах, а
// кириллица занимает по два — если границы поедут, заголовки посыплются
// молча. Плюс `indexOf('<programme')` сам по себе не отличает `<programme>`
// от `<programmes>`, что регулярка делала через `\b`.
describe('programmes: побайтовый разбор', () => {
  const channels = [{ id: 'ch1' }];
  const src = '<tv><programme start="20260830140000 +0000" channel="ch1">'
    + '<title>Футбол. «Зенит» – ЦСКА</title></programme></tv>';

  test('Buffer и строка дают одинаковый результат', () => {
    const fromString = programmes(src, channels).list;
    const fromBuffer = programmes(Buffer.from(src, 'utf8'), channels).list;
    assert.deepStrictEqual(fromBuffer, fromString);
  });

  test('кириллица в заголовке не бьётся о границы байтовых срезов', () => {
    const { list } = programmes(Buffer.from(src, 'utf8'), channels);
    assert.strictEqual(list[0].title, 'Футбол. «Зенит» – ЦСКА');
  });

  test('кириллица в атрибутах тоже переживает срез', () => {
    const cyr = '<tv><programme start="20260830140000 +0000" channel="ка-нал">'
      + '<title>Т</title></programme></tv>';
    const { list } = programmes(cyr, [{ id: 'ка-нал' }]);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].channelId, 'ка-нал');
  });

  test('<programmes> не принимается за <programme>', () => {
    const decoy = '<tv><programmes count="5" channel="ch1" start="20260830140000 +0000">'
      + '<title>Не передача</title></programmes></tv>';
    assert.strictEqual(programmes(decoy, channels).list.length, 0);
  });

  test('оборванный тег в конце файла не роняет разбор', () => {
    const cut = `<tv>${src.slice(4, -5)}<programme start="2026`;
    assert.doesNotThrow(() => programmes(cut, channels));
  });
});

// Матчер смотрит только в окна ±90 минут вокруг свистков, поэтому всё, что
// лежит вне них, можно не тащить в память вовсе: на живом фиде это 73%
// передач. Фильтр обязан быть точным — отрезать лишнее, но не тронуть
// ничего, до чего матчер способен дотянуться.
describe('programmes: отсечение по окнам матчей', () => {
  const K = Date.UTC(2026, 7, 30, 18, 0, 0);
  const at = (offsetMin, id) => `<programme start="${
    new Date(K + offsetMin * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  } +0000" channel="ch1"><title>П${id}</title></programme>`;

  // -400 и +400 минут — заведомо вне окна; ±89 — заведомо внутри.
  const xml = `<tv>${at(-400, 1)}${at(-89, 2)}${at(0, 3)}${at(89, 4)}${at(400, 5)}</tv>`;
  const channels = [{ id: 'ch1' }];

  test('без списка свистков фид не фильтруется вовсе', () => {
    const { list, total } = programmes(xml, channels);
    assert.strictEqual(list.length, 5);
    assert.strictEqual(total, 5);
  });

  test('со свистком остаётся только его окно', () => {
    const { list } = programmes(xml, channels, [K]);
    assert.deepStrictEqual(list.map((p) => p.title), ['П2', 'П3', 'П4']);
  });

  test('`total` считает весь фид, а не остаток — статистика синка не врёт', () => {
    const { list, total } = programmes(xml, channels, [K]);
    assert.strictEqual(total, 5);
    assert.strictEqual(list.length, 3);
  });

  test('несколько свистков дают несколько окон', () => {
    const { list } = programmes(xml, channels, [K, K + 400 * 60000]);
    assert.deepStrictEqual(list.map((p) => p.title), ['П2', 'П3', 'П4', 'П5']);
  });

  test('отсечённое действительно недостижимо для матчера', () => {
    // Полный список и урезанный обязаны дать один и тот же ответ: настоящая
    // трансляция лежит в окне и остаётся, а всё выброшенное матчер и так не
    // открыл бы. Заодно ловушка — тот же матч стоит и далеко за окном.
    const title = '<title>Футбол. Барселона – Атлетик</title>';
    const withMatch = `<tv>
      <programme start="20260830120000 +0000" channel="ch1">${title}</programme>
      <programme start="20260830180000 +0000" channel="ch1">${title}</programme>
    </tv>`;
    const full = programmes(withMatch, channels).list;
    const cut = programmes(withMatch, channels, [K]).list;
    assert.strictEqual(full.length, 2);
    assert.strictEqual(cut.length, 1, 'дальняя копия не отсечена');

    const find = (l) => findBroadcastChannels(l, 'Barcelona', 'Athletic Club', K, 'Barcelona', 'Athletic');
    assert.deepStrictEqual(find(full), ['ch1']);
    assert.deepStrictEqual(find(cut), find(full), 'фильтр изменил результат матчера');
  });
});
