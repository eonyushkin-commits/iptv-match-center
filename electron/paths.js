'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// In a packaged build ROOT points inside app.asar, which is read-only. Config,
// cache and the playlist have to live somewhere writable instead:
//   %APPDATA%\iptv-match-center        Windows
//   ~/.config/iptv-match-center        Linux
//   ~/Library/Application Support/iptv-match-center   macOS
const dataDir = app.isPackaged ? app.getPath('userData') : ROOT;

// Tracked in git as a blank template — the live config.json (personal
// playlist/EPG paths) is gitignored and never itself committed.
const bundledConfig = path.join(ROOT, 'config.example.json');
const configPath = path.join(dataDir, 'config.json');

/** Seeds the writable config from the bundled defaults on first launch. */
function ensureConfig() {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(bundledConfig, configPath);
  }
  return configPath;
}

function resolvePlaylist(p) {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return path.isAbsolute(p) ? p : path.join(dataDir, p);
}

module.exports = {
  ROOT,
  configPath,
  cacheDir: path.join(dataDir, 'cache'),
  ensureConfig,
  resolvePlaylist,
};
