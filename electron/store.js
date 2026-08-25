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

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

module.exports = { setRoot, readJson, writeJson, get root() { return root; } };
