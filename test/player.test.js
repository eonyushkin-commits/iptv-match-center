'use strict';
// В предыдущем проекте этот модуль был единственным без единого теста — и
// именно он дал два настоящих бага, найденных ручным тыканьем уже после
// релиза: падение главного процесса на ошибке spawn и осиротевшие процессы
// VLC от двух быстрых кликов. Оба воспроизводятся здесь за миллисекунды,
// потому что spawn, HTTP-управление и ожидание передаются извне.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createPlayer } = require('../main/player');

/** Дочерний процесс-обманка: ровно тот интерфейс, что использует player.js. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; return true; };
  return child;
}

/** Плеер с подставленным окружением. `control` по умолчанию отвечает «да»,
 * то есть VLC поднялся и слушает. */
function harness({ control = async () => true, onSpawn } = {}) {
  const spawned = [];
  const player = createPlayer({
    spawn: (path, args) => {
      const child = fakeChild();
      spawned.push({ path, args, child });
      if (onSpawn) onSpawn(child, spawned.length);
      return child;
    },
    control,
    allocPort: async () => 45000 + spawned.length,
    wait: async () => {}, // без задержек — тесты не должны ничего ждать
  });
  return { player, spawned };
}

describe('запуск VLC', () => {
  test('поднимает процесс и считает себя работающим', async () => {
    const { player, spawned } = harness();
    await player.play('vlc.exe', 'http://s/1.m3u8');
    assert.strictEqual(spawned.length, 1);
    assert.ok(player.isRunning());
  });

  test('поток и пароль уходят в аргументы, URL первым', async () => {
    const { player, spawned } = harness();
    await player.play('vlc.exe', 'http://s/1.m3u8');
    const { args } = spawned[0];
    assert.strictEqual(args[0], 'http://s/1.m3u8');
    assert.ok(args.some((a) => a.startsWith('--http-port=')));
    assert.ok(args.some((a) => a.startsWith('--http-password=')));
    // Булев флаг VLC не принимает в виде `=no` — только отдельным --no-…
    assert.ok(args.includes('--no-play-and-exit'));
    assert.ok(!args.some((a) => a.includes('=no')));
  });

  test('User-Agent добавляется, только если задан', async () => {
    const a = harness();
    await a.player.play('vlc.exe', 'u');
    assert.ok(!a.spawned[0].args.some((x) => x.startsWith('--http-user-agent=')));

    const b = harness();
    await b.player.play('vlc.exe', 'u', 'MyAgent/1.0');
    assert.ok(b.spawned[0].args.includes('--http-user-agent=MyAgent/1.0'));
  });
});

describe('ошибка запуска не роняет процесс', () => {
  // Ровно тот случай, что показывал модальное окно «A JavaScript error
  // occurred in the main process»: событие 'error' без слушателя.
  test('ENOENT приходит ловимой ошибкой с внятным текстом', async () => {
    const { player } = harness({
      onSpawn: (child) => {
        const err = new Error('spawn C:\\nope\\vlc.exe ENOENT');
        err.code = 'ENOENT';
        queueMicrotask(() => child.emit('error', err));
      },
    });
    await assert.rejects(
      () => player.play('C:\\nope\\vlc.exe', 'u'),
      (e) => e.message.includes('файл не найден'),
    );
    assert.ok(!player.isRunning());
  });

  test('другая ошибка запуска доносится как есть', async () => {
    const { player } = harness({
      onSpawn: (child) => {
        const err = new Error('spawn EACCES');
        err.code = 'EACCES';
        queueMicrotask(() => child.emit('error', err));
      },
    });
    await assert.rejects(() => player.play('vlc.exe', 'u'), /EACCES/);
  });

  test('процесс, умерший сразу после старта, не выглядит как успех', async () => {
    const { player } = harness({ onSpawn: (child) => { child.exitCode = 1; } });
    await assert.rejects(() => player.play('vlc.exe', 'u'), /завершился сразу/);
    assert.ok(!player.isRunning());
  });

  test('VLC не отвечает по HTTP — запуск считается неудачным, процесс убит', async () => {
    const { player, spawned } = harness({ control: async () => false });
    await assert.rejects(() => player.play('vlc.exe', 'u'), /не отозвался/);
    assert.ok(spawned[0].child.killed, 'зависший процесс надо прибрать');
    assert.ok(!player.isRunning());
  });
});

describe('два быстрых клика', () => {
  // Раньше `current` присваивался только в конце запуска, и всё это время
  // второй вызов видел пустоту и поднимал свой экземпляр. Второй затирал
  // current собой, первый оставался осиротевшим навсегда и переживал даже
  // закрытие приложения.
  test('поднимается ОДИН процесс, а не два', async () => {
    const { player, spawned } = harness();
    await Promise.all([
      player.play('vlc.exe', 'http://s/1.m3u8'),
      player.play('vlc.exe', 'http://s/2.m3u8'),
    ]);
    assert.strictEqual(spawned.length, 1, 'второй клик обязан переиспользовать процесс');
  });

  test('три клика подряд — по-прежнему один процесс', async () => {
    const { player, spawned } = harness();
    await Promise.all([
      player.play('vlc.exe', 'a'),
      player.play('vlc.exe', 'b'),
      player.play('vlc.exe', 'c'),
    ]);
    assert.strictEqual(spawned.length, 1);
  });

  test('после неудачного первого запуска второй клик пробует заново, но тоже один раз', async () => {
    let n = 0;
    const { player, spawned } = harness({
      onSpawn: (child) => { if (++n === 1) child.exitCode = 1; },
    });
    const [first, second] = await Promise.allSettled([
      player.play('vlc.exe', 'a'),
      player.play('vlc.exe', 'b'),
    ]);
    assert.strictEqual(first.status, 'rejected');
    assert.strictEqual(second.status, 'fulfilled', 'отказ первого не должен рвать очередь');
    assert.strictEqual(spawned.length, 2, 'ровно одна повторная попытка');
    assert.ok(player.isRunning());
  });
});

describe('переключение канала', () => {
  test('идёт через HTTP, окно не пересоздаётся', async () => {
    const calls = [];
    const { player, spawned } = harness({
      control: async (_p, _pw, params) => { calls.push(params); return true; },
    });
    await player.play('vlc.exe', 'http://s/1.m3u8');
    await player.play('vlc.exe', 'http://s/2.m3u8');

    assert.strictEqual(spawned.length, 1, 'второй канал не должен поднимать новый VLC');
    assert.ok(calls.some((c) => c.command === 'pl_empty'));
    assert.ok(calls.some((c) => c.command === 'in_play' && c.input === 'http://s/2.m3u8'));
  });

  test('интерфейс управления замолчал — перезапуск, а не тихое бездействие', async () => {
    // Первый запуск удаётся, потом VLC перестаёт отвечать, потом новый
    // процесс отвечает снова.
    let alive = true;
    let spawns = 0;
    const player = createPlayer({
      spawn: () => { spawns++; alive = true; return fakeChild(); },
      control: async (_p, _pw, params) => (params.command === 'status' ? alive : (alive = false)),
      allocPort: async () => 45001,
      wait: async () => {},
    });
    await player.play('vlc.exe', 'a');
    assert.strictEqual(spawns, 1);
    await player.play('vlc.exe', 'b');
    assert.strictEqual(spawns, 2, 'молчащий интерфейс лечится перезапуском');
  });
});

describe('остановка', () => {
  test('stop() убивает процесс и снимает состояние', async () => {
    const { player, spawned } = harness();
    await player.play('vlc.exe', 'u');
    player.stop();
    assert.ok(spawned[0].child.killed);
    assert.ok(!player.isRunning());
  });

  test('stop() без запущенного плеера ничего не ломает', () => {
    const { player } = harness();
    assert.doesNotThrow(() => player.stop());
  });

  test('самостоятельно умерший VLC перестаёт числиться живым', async () => {
    const { player, spawned } = harness();
    await player.play('vlc.exe', 'u');
    spawned[0].child.emit('exit', 0);
    assert.ok(!player.isRunning(), 'закрытое пользователем окно должно сниматься с учёта');
  });
});
