'use strict';
const path = require('path');
const store = require('./store');

// Favorited match ids -- FotMob's own match id (`event.id` in guide.json),
// stable across syncs as long as the fixture is still in the tracked
// window. A flat JSON file, same pattern as guide.json itself; no need for
// anything heavier at this scale (a handful of ids at most).
function filePath() {
  return path.join(store.root, 'favorites.json');
}

function load() {
  return store.readJson(filePath(), { ids: [] }).ids || [];
}

function toggle(id) {
  const ids = new Set(load());
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  const list = [...ids];
  store.writeJson(filePath(), { ids: list });
  return list;
}

module.exports = { load, toggle };
