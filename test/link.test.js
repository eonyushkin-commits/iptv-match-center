'use strict';
// Регрессия на сопоставление матчей с передачами EPG — самая калиброванная и
// самая хрупкая часть. Каждый негативный случай здесь — реальное ложное
// срабатывание, пойманное на живых данных предыдущего проекта; каждый
// позитивный — реальная трансляция, которая обязана находиться.
//
// Сети и диска не касается.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const link = require('../main/link');
const teams = require('../main/teams');

const KICKOFF = Date.UTC(2026, 7, 30, 18, 0, 0);
const ALIASES = teams.SEED; // словарь без обращения к диску

/** Один канал, одна передача со сдвигом от стартового свистка. */
function slot(title, offsetMin = 0, channelId = 'ch1') {
  const start = KICKOFF + offsetMin * 60000;
  return [{ channelId, title, start, stop: start + 120 * 60000 }];
}

function match(home, away, homeShort, awayShort, programmes) {
  const fixture = { id: 'f1', home, away, homeShort, awayShort, start: KICKOFF };
  return link.fromEpg(programmes, fixture, {
    home: teams.formsFor(ALIASES, home, homeShort),
    away: teams.formsFor(ALIASES, away, awayShort),
  });
}

const finds = (home, away, hs, as, title, offsetMin = 0) =>
  match(home, away, hs, as, slot(title, offsetMin)).length > 0;

describe('находит настоящие трансляции', () => {
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
    ['словарь: переведённый экзоним (Бавария)',
      'Bayern München', 'VfB Stuttgart', 'Bayern', 'Stuttgart',
      '⋗ Футбол. Германия. Бавария – Штутгарт'],
    ['словарь: транслит произношения (Гоу Эхед Иглс)',
      'AZ Alkmaar', 'Go Ahead Eagles', 'AZ', 'Go Ahead',
      '⋗ Футбол. Нидерланды. АЗ Алкмаар – Гоу Эхед Иглс'],
    ['словарь: диакритика (Бешикташ)',
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

describe('не ловит чужое', () => {
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

describe('окно ±90 минут вокруг свистка', () => {
  const pair = ['Tottenham Hotspur', 'Newcastle United', 'Tottenham', 'Newcastle',
    'Football. Tottenham Hotspur v Newcastle United'];
  test('за 89 минут до свистка — находит', () => assert.ok(finds(...pair, -89)));
  test('через 89 минут после свистка — находит', () => assert.ok(finds(...pair, 89)));
  test('за 3 часа до свистка — не находит', () => assert.ok(!finds(...pair, -180)));
  test('через 3 часа после свистка — не находит', () => assert.ok(!finds(...pair, 180)));
});

// Разрыв, найденный тестами предыдущего проекта: слово, единственное
// способное связать имя команды с заголовком, отбирает у неё СОБСТВЕННЫЙ
// соперник. «Ньюкасл» -> nyukasl, до «newcastle» 5 правок при допуске 3, так
// что мостом работает только «Юнайтед», а его вычитают у обеих сторон разом.
// Закрыт двумя записями словаря — тесты держат обе.
describe('токен, общий с соперником, не должен обнулять пару', () => {
  const cases = [
    ['«Тоттенхэм – Ньюкасл»', 'Tottenham Hotspur', 'Newcastle United', 'Tottenham', 'Newcastle',
      '⋗ Футбол. Англия. Тоттенхэм – Ньюкасл'],
    ['«Ньюкасл – Ливерпуль»', 'Newcastle United', 'Liverpool', 'Newcastle', 'Liverpool',
      '⋗ Футбол. Англия. Ньюкасл – Ливерпуль'],
    ['два «юнайтеда» в одной паре', 'Newcastle United', 'West Ham United', 'Newcastle', 'West Ham',
      '⋗ Футбол. Англия. Ньюкасл – Вест Хэм'],
  ];
  for (const [label, home, away, hs, as, title] of cases) {
    test(label, () => assert.ok(finds(home, away, hs, as, title), `не найдено: ${title}`));
  }
});

// Ради этого вся модель и переделана: связь теперь несёт улику. В предыдущем
// проекте канал попадал в карточку безымянно, и на вопрос «почему он здесь»
// нельзя было ответить, не прогнав сопоставление заново.
describe('происхождение связи сохраняется', () => {
  test('возвращается заголовок и время подтвердившей передачи', () => {
    const [found] = match('Barcelona', 'Athletic Club', 'Barcelona', 'Athletic',
      slot('⋗ Футбол. Испания. Барселона – Атлетик', -30));
    assert.strictEqual(found.channelId, 'ch1');
    assert.strictEqual(found.title, '⋗ Футбол. Испания. Барселона – Атлетик');
    assert.strictEqual(found.start, KICKOFF - 30 * 60000);
    assert.strictEqual(found.stop, KICKOFF + 90 * 60000);
  });

  test('точное совпадение по токену помечено как точное', () => {
    const [found] = match('Tottenham Hotspur', 'Newcastle United', 'Tottenham', 'Newcastle',
      slot('Tottenham Hotspur v Newcastle United'));
    assert.strictEqual(found.exact, true);
  });

  test('совпадение через транслитерацию помечено как неточное', () => {
    const [found] = match('Juventus', 'Milan', 'Juventus', 'Milan',
      slot('⋗ Футбол. Италия. Ювентус – Милан'));
    assert.strictEqual(found.exact, false, 'Ювентус ~ Juventus — это нечёткая ветка');
  });

  test('нечёткое попадание предлагается в словарь, а не применяется молча', () => {
    const candidates = new Map();
    const fixture = { id: 'f1', home: 'Juventus', away: 'Milan', homeShort: 'Juventus', awayShort: 'Milan', start: KICKOFF };
    link.fromEpg(slot('⋗ Футбол. Италия. Ювентус – Милан'), fixture, {
      home: teams.formsFor(ALIASES, 'Juventus', 'Juventus'),
      away: teams.formsFor(ALIASES, 'Milan', 'Milan'),
    }, candidates);
    assert.ok(candidates.has('Juventus'), 'кандидат обязан попасть в предложения');
    assert.ok([...candidates.get('Juventus')].includes('yuventus'));
  });

  test('на канале несколько подходящих передач — берётся ближайшая к свистку', () => {
    const title = 'Футбол. Испания. Барселона – Атлетик';
    const progs = [
      ...slot(`Анонс. ${title}`, -80),
      ...slot(title, -5),
      ...slot(`Обзор. ${title}`, 85),
    ];
    const found = match('Barcelona', 'Athletic Club', 'Barcelona', 'Athletic', progs);
    assert.strictEqual(found.length, 1, 'один канал — одна связь');
    assert.strictEqual(found[0].start, KICKOFF - 5 * 60000);
  });

  test('несколько каналов — несколько связей', () => {
    const title = '⋗ Футбол. Испания. Барселона – Атлетик';
    const progs = [...slot(title, 0, 'ch1'), ...slot(title, 0, 'ch2')];
    const found = match('Barcelona', 'Athletic Club', 'Barcelona', 'Athletic', progs);
    assert.deepStrictEqual(found.map((f) => f.channelId).sort(), ['ch1', 'ch2']);
  });
});

describe('isOtherSport', () => {
  test('кириллица ловится (через \\b она молча не ловилась вовсе)', () => {
    assert.ok(link.isOtherSport('Автоспорт. Российская серия кольцевых гонок'));
    assert.ok(link.isOtherSport('Швеция – Франция. Баскетбол'));
  });
  test('латиница и другие языки', () => {
    assert.ok(link.isOtherSport('NHL: Rangers at Bruins'));
    assert.ok(link.isOtherSport('Siatkówka: Polska - Serbia'));
  });
  test('футбольный заголовок не считается другим спортом', () => {
    assert.ok(!link.isOtherSport('⋗ Футбол. Англия. Тоттенхэм – Ньюкасл'));
    assert.ok(!link.isOtherSport('EFL Championship: Preston – Bristol City'));
  });
});
