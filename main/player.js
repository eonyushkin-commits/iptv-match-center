'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const netSockets = require('node:net');
const crypto = require('crypto');

const CANDIDATE_PATHS = [
  'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
  'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
];

function findVlcPath(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  for (const p of CANDIDATE_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

/** Порт, который ОС отдала как свободный. Захардкоженный номер молча ломал
 * управление, если оказывался занят другой программой или вторым экземпляром
 * приложения: HTTP-интерфейс VLC не поднимался, и переключение канала
 * переставало работать совсем, без единой ошибки. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netSockets.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** @returns подтвердил ли VLC команду. */
function httpControl(port, password, params) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(params).toString();
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: `/requests/status.xml?${qs}`,
      auth: `:${password}`,
      timeout: 3000,
    }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      res.resume();
      res.on('end', () => resolve(ok));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const READY_STEP_MS = 250;
const READY_STEPS = 40;

/**
 * Плеер поверх отдельного окна VLC.
 *
 * Все внешние зависимости — параметры, а не жёсткие require. Смысл не в
 * абстракции ради абстракции: в предыдущем проекте этот модуль был
 * единственным без единого теста, и именно он дал два настоящих бага — падение
 * главного процесса на `spawn` и осиротевшие процессы от двух быстрых кликов.
 * Оба нашлись ручным тыканьем уже после релиза. Со швом их ловит `npm test`.
 */
function createPlayer(deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const control = deps.control || httpControl;
  const allocPort = deps.allocPort || freePort;
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let current = null; // { child, port, password }

  /**
   * Запуски строго по одному, в порядке поступления.
   *
   * Без этого два быстрых клика поднимали ДВА процесса VLC: `current`
   * присваивается только в конце запуска, а он длится секунды — всё это время
   * второй вызов видит пустоту и честно запускает свой экземпляр. Второй
   * затирал `current` собой, первый оставался осиротевшим навсегда и
   * переживал закрытие приложения.
   *
   * Очередь, а не флаг «занято»: второй клик не теряется, а дожидается конца
   * запуска и дальше идёт обычным путём — переключением канала в уже поднятом
   * окне.
   */
  let queue = Promise.resolve();
  function play(vlcPath, url, userAgent) {
    const next = queue.then(() => playOne(vlcPath, url, userAgent));
    queue = next.catch(() => {});
    return next;
  }

  async function playOne(vlcPath, url, userAgent) {
    if (current) {
      const emptied = await control(current.port, current.password, { command: 'pl_empty' });
      if (emptied && await control(current.port, current.password, { command: 'in_play', input: url })) return;
      // Интерфейс управления не отвечает: VLC завис, порт перехватили или
      // процесс уже мёртв, а мы об этом ещё не знаем. Раньше на этом всё и
      // заканчивалось — клик по другому каналу молча не делал ничего.
      stop();
    }

    const port = await allocPort();
    const password = crypto.randomBytes(12).toString('hex');
    const args = [
      url,
      '--no-video-title-show',
      '--no-qt-privacy-ask',
      '--no-qt-error-dialogs',
      '--no-play-and-exit', // именно так: VLC не принимает `=no` у булевых
      // HTTP-интерфейс — и пульт для переключения канала, и признак того, что
      // VLC вообще поднялся (см. ниже).
      '--extraintf=http', '--http-host=127.0.0.1', `--http-port=${port}`, `--http-password=${password}`,
    ];
    // Часть провайдеров отвергает стандартный User-Agent VLC на сегментах.
    if (userAgent) args.push(`--http-user-agent=${userAgent}`);

    const child = spawn(vlcPath, args, { stdio: 'ignore' });

    // Ошибка запуска приходит СОБЫТИЕМ, а не исключением. Без этого слушателя
    // EventEmitter превращает её в необработанное исключение главного
    // процесса, и Electron показывает пользователю модальное окно «A
    // JavaScript error occurred in the main process» со стеком. Достижимо
    // буднично: путь к VLC хранится в конфиге, а сам VLC потом удаляют,
    // переносят или он лежит на отключённом сетевом диске.
    let spawnError = null;
    child.on('error', (err) => { spawnError = err; });
    child.on('exit', () => { if (current?.child === child) current = null; });

    // Готовность — по ОТВЕТУ HTTP-интерфейса, а не по появлению окна в списке
    // окон ОС. Предыдущий проект искал окно через EnumWindows/koffi: это
    // тянуло нативную зависимость, работало только на Windows и отвечало на
    // вопрос «нарисовалось ли окно», тогда как нужен ответ на «управляем ли мы
    // плеером». Ответивший интерфейс отвечает на второй вопрос — и именно он
    // нужен, чтобы следующий клик переключил канал, а не поднял второй VLC.
    for (let i = 0; i < READY_STEPS; i++) {
      await wait(READY_STEP_MS);
      // Оба признака провала видны уже на первом шаге. Раньше цикл в любом
      // случае отрабатывал все сорок: на неверном пути пользователь десять
      // секунд смотрел на «Запускаю VLC…», прежде чем получить ошибку.
      if (spawnError) {
        throw new Error(spawnError.code === 'ENOENT' ? `файл не найден: ${vlcPath}` : spawnError.message);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('VLC завершился сразу после запуска — проверьте путь в «Настройках»');
      }
      if (await control(port, password, { command: 'status' })) {
        current = { child, port, password };
        return;
      }
    }

    try { child.kill(); } catch { /* уже мёртв */ }
    throw new Error('VLC не отозвался после запуска');
  }

  function stop() {
    if (!current) return;
    try { current.child.kill(); } catch { /* уже мёртв */ }
    current = null;
  }

  return { play, stop, isRunning: () => current !== null };
}

// Окно VLC намеренно НЕ позиционируется. В предыдущем проекте это стоило
// нативной зависимости (koffi), сорока строк Win32, борьбы с состоянием
// WS_MAXIMIZE и пяти переустановок позиции таймерами в первые 3.5 секунды —
// всё ради того, чтобы окно не легло поверх нашего. Пользователь решает ту же
// задачу, один раз перетащив окно: VLC сам запоминает своё положение между
// запусками, как и любое отдельное приложение.
module.exports = { createPlayer, findVlcPath, freePort, httpControl };
