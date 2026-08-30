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
const { similarity, tokens } = require('../electron/normalize');

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

// Известные пробелы. Тесты описывают ЖЕЛАЕМОЕ поведение и помечены todo:
// они не валят прогон, но и не дают о себе забыть. Когда пробел закроют —
// снять пометку, а не переписывать ожидание.
describe('findBroadcastChannels: известные пробелы', () => {
  // «Ньюкасл» → nyukasl, до «newcastle» 5 правок при допуске 3 — единственный
  // мост это «Юнайтед». Но meaningfulTeamTokens вычитает слово, общее с
  // соперником, так что в паре двух «юнайтедов» моста не остаётся вовсе.
  // «Вест Хэм» → vest/hem, оба короче порога длины 5, тоже не мост.
  test('Ньюкасл Юнайтед – Вест Хэм Юнайтед: «Юнайтед» вычитается у обоих', { todo: true }, () => {
    assert.ok(finds('Newcastle United', 'West Ham United', 'Newcastle', 'West Ham',
      '⋗ Футбол. Англия. Ньюкасл Юнайтед – Вест Хэм Юнайтед'));
  });

  // Вещатель пишет короткое русское имя без «Юнайтед» — в живом EPG таких
  // заголовков 3 из 16 упоминаний Ньюкасла.
  test('«Тоттенхэм – Ньюкасл»: короткое русское имя без «Юнайтед»', { todo: true }, () => {
    assert.ok(finds('Newcastle United', 'Tottenham Hotspur', 'Newcastle', 'Tottenham',
      '⋗ Футбол. АПЛ, 2 тур, Тоттенхэм – Ньюкасл'));
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
