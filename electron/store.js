'use strict';
const fs = require('fs');
const path = require('path');

let root = path.join(__dirname, '..', 'cache');

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
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

module.exports = { setRoot, readJson, writeJson, get root() { return root; } };
