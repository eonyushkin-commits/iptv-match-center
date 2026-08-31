'use strict';
// Рабочий поток: тяжёлая половина синхронизации целиком (скачивание EPG,
// разбор фида, сопоставление, отсев заявок вещателей). В main-процессе всё
// это занимало поток на секунды подряд, а он же обслуживает ввод и IPC —
// окно выглядело зависшим.
//
// Здесь намеренно нет никакой логики, только передача сообщений: вся работа
// в epg-stage.js, который можно вызвать и проверить напрямую, без потоков.
//
// Electron-модули отсюда недоступны и не нужны: сетевые вызовы к FotMob
// (им нужен стек Chromium) остались в main, сюда приходит уже готовый
// результат, а EPG-фид качается обычным fetch — это ссылка провайдера
// пользователя, не защищённый от ботов API.
const { parentPort, workerData } = require('worker_threads');
const stage = require('./epg-stage');

stage.run(workerData, (text) => parentPort.postMessage({ type: 'progress', text }))
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((err) => parentPort.postMessage({ type: 'error', message: err.message }));
