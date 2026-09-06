'use strict';
const fs = require('fs');
const path = require('path');

// Не `cache` даже как значение по умолчанию — почему именно, см. paths.js.
let root = path.join(__dirname, '..', 'data');

function setRoot(dir) {
  root = dir;
  fs.mkdirSync(root, { recursive: true });
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

// Через временный файл и переименование, а не поверх живого. guide.json
// весит сотни килобайт; падение (или выключение машины) посреди записи
// оставляло обрезанный JSON, а readJson на нём молча отдаёт fallback — со
// стороны это выглядит как «сетка пропала без причины». Переименование в
// пределах одного каталога атомарно и на Windows заменяет существующий файл.
function writeJson(p, value, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Имя временного файла — с номером процесса. Общее `${p}.tmp` означало бы,
  // что два пишущих процесса (второй экземпляр приложения, диагностический
  // скрипт рядом) наступают друг другу на этот файл и могут оставить после
  // себя обрезанный результат вместо целого.
  const tmp = `${p}.${process.pid}.tmp`;
  // Отступы — для файлов, которые человек открывает и правит (конфиг, словарь
  // команд). Индекс EPG человек не читает, а весит он десятки мегабайт: там
  // отступы это лишние секунды на сериализацию и лишние мегабайты на диске.
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0));
  fs.renameSync(tmp, p);
}

module.exports = { setRoot, readJson, writeJson, get root() { return root; } };
