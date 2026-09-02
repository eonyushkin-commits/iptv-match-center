'use strict';
// Единственное место, где проекту нужен нативный код: чужое окно (VLC) не
// подвинуть ни средствами Electron, ни ключами командной строки самого VLC.
//
// Вынесено отдельным модулем и грузится ЛЕНИВО — `koffi.load('user32.dll')`
// выполняется при первом обращении, а не при импорте. Благодаря этому
// player.js и его тесты не тянут за собой ни koffi, ни Windows: тест
// подставляет свою функцию размещения и ни разу сюда не заходит.
const koffi = require('koffi');

let api = null;

function load() {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const HWND = koffi.pointer('HWND', koffi.opaque());
  const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(HWND hwnd, intptr lParam)');
  api = {
    HWND,
    EnumWindowsProc,
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr lParam)'),
    GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32 *lpdwProcessId)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(HWND hWnd)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)'),
  };
  return api;
}

const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const SW_RESTORE = 9;

/** Первое видимое окно процесса. */
function findWindowForPid(pid) {
  const { EnumWindows, EnumWindowsProc, GetWindowThreadProcessId, IsWindowVisible } = load();
  const found = [];
  const cb = koffi.register((hwnd) => {
    const pidBuf = [0];
    GetWindowThreadProcessId(hwnd, pidBuf);
    if (pidBuf[0] === pid && IsWindowVisible(hwnd)) found.push(hwnd);
    return true;
  }, koffi.pointer(EnumWindowsProc));
  // unregister — в finally: пул зарегистрированных колбэков у koffi
  // ограничен, а функция вызывается по нескольку раз за запуск. Бросок из
  // EnumWindows оставлял бы слот занятым навсегда.
  try {
    EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return found[0] || null;
}

/**
 * Ставит окно в заданный прямоугольник (физические пиксели экрана).
 *
 * `SW_RESTORE` перед каждым `SetWindowPos` — обязателен, а не подстраховка:
 * развёрнутое окно игнорирует размер и позицию из `SetWindowPos` (Windows
 * продолжает рисовать его по рабочей области монитора), пока его явно не
 * вывели из состояния «развёрнуто». Вызов при этом честно возвращает
 * «успех», так что по коду возврата ошибку не увидеть — ловится только
 * глазами.
 */
function place(hwnd, { x, y, width, height }) {
  const { ShowWindow, SetWindowPos } = load();
  ShowWindow(hwnd, SW_RESTORE);
  SetWindowPos(hwnd, null, Math.round(x), Math.round(y), Math.round(width), Math.round(height),
    SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}

const hide = (hwnd) => load().ShowWindow(hwnd, SW_HIDE);
const showNoActivate = (hwnd) => load().ShowWindow(hwnd, SW_SHOWNOACTIVATE);

module.exports = { findWindowForPid, place, hide, showNoActivate };
