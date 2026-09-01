'use strict';
// Десять строк передачи сообщений поверх epg-stage.js. Вся логика — там, и
// потому проверяется напрямую, без потоков.
const { parentPort, workerData } = require('worker_threads');
const stage = require('./epg-stage');

stage.run(workerData, (text) => parentPort.postMessage({ type: 'progress', text }))
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((err) => parentPort.postMessage({ type: 'error', message: err.message }));
