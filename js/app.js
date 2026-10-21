/**
 * app.js — UI logic (navigation, sheets, manual entry, service worker).
 * All barcode/camera logic lives in ./scanner.js.
 */

import { BarcodeScanner, ScannerError, isCameraApiAvailable } from './scanner.js';

/* ---------- Helpers ---------- */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Converts ASCII digits to their Persian glyphs for UI text. */
function toPersianDigits(value) {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/** Normalises Persian / Arabic-Indic digits back to ASCII for validation. */
function toAsciiDigits(value) {
  return String(value)
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Persian copy for every error the scanner can raise. */
const ERROR_MESSAGES = {
  insecure:
    'برای استفاده از دوربین باید صفحه در HTTPS یا localhost باز شده باشد. آدرس را بررسی کنید.',
  unsupported: 'مرورگر شما از دوربین یا اسکن بارکد پشتیبانی نمی‌کند. مرورگر دیگری را امتحان کنید.',
  denied: 'دسترسی به دوربین رد شد. لطفاً در تنظیمات مرورگر اجازه دوربین را بدهید و دوباره تلاش کنید.',
  nocamera: 'دوربینی پیدا نشد. اگر از گوشی استفاده می‌کنید، دوربین دستگاه را بررسی کنید.',
  inuse: 'دوربین در حال حاضر توسط برنامه دیگری استفاده می‌شود. آن برنامه را ببندید و دوباره تلاش کنید.',
};

/* ---------- Platform helpers ---------- */

/** iOS (any browser, they all ship WebKit) — used for the install hint. */
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** True when running as an installed (standalone) app. */
function isStandalone() {
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes navigator.standalone; it is true only in home-screen mode.
  if (typeof navigator.standalone === 'boolean') return navigator.standalone;
  return false;
}

/** Short haptic feedback. iOS Safari does not implement vibration at all. */
function buzz(duration) {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(duration);
  } catch (error) {
    // Unsupported or blocked (e.g. iOS) — scanning simply continues silently.
  }
}

/* ---------- Element references ---------- */

const screens = {
  home: document.getElementById('screen-home'),
  scan: document.getElementById('screen-scan'),
  history: document.getElementById('screen-history'),
};

const navItems = Array.from(document.querySelectorAll('.nav-item'));
const video = document.getElementById('camera-preview');
const scanErrorBox = document.getElementById('scan-error');
const scanErrorText = document.getElementById('scan-error-text');
const scanHint = document.getElementById('scan-hint');

const resultSheet = document.getElementById('result-sheet');
const resultBackdrop = document.getElementById('result-backdrop');
const resultCode = document.getElementById('result-code');

const manualSheet = document.getElementById('manual-sheet');
const manualBackdrop = document.getElementById('manual-backdrop');
const manualInput = document.getElementById('manual-input');
const manualError = document.getElementById('manual-error');

/* ---------- Screen navigation ---------- */

/** Shows one screen and keeps the bottom navigation in sync. */
function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => {
    const isActive = key === name;
    element.classList.toggle('screen--active', isActive);
    element.hidden = !isActive;
  });

  navItems.forEach((item) => {
    const isActive = item.dataset.nav === name;
    item.classList.toggle('nav-item--active', isActive);
    item.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  document.body.classList.toggle('is-scanning', name === 'scan');
}

/* ---------- Bottom sheets ---------- */

const openSheets = new Set();

function openSheet(sheet, backdrop) {
  sheet.hidden = false;
  backdrop.hidden = false;
  openSheets.add(sheet);
  // Force a frame so the entrance transition actually plays.
  requestAnimationFrame(() => {
    sheet.classList.add('is-open');
    backdrop.classList.add('is-open');
  });
}

function closeSheet(sheet, backdrop) {
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  openSheets.delete(sheet);

  const hide = () => {
    if (openSheets.has(sheet)) return;
    sheet.hidden = true;
    backdrop.hidden = true;
  };

  // Wait for the slide-out transition (or a timeout as a safety net).
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    hide();
  };
  sheet.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 320);
}

/* ---------- Scanner wiring ---------- */

let scanner = null;
let lastDetectedCode = null;
let lastDetectedAt = 0;

/** Starts the camera on the scan screen and shows a Persian error if it fails. */
async function startScanner() {
  hideScanError();

  if (!isCameraApiAvailable()) {
    showScanError(ERROR_MESSAGES[window.isSecureContext ? 'unsupported' : 'insecure']);
    return;
  }

  scanner = new BarcodeScanner(video, {
    onDetect: handleDetected,
    onError: (error) => showScanError(errorMessageFor(error)),
  });

  try {
    await scanner.start();
    scanHint.hidden = false;
  } catch (error) {
    showScanError(errorMessageFor(error));
  }
}

function errorMessageFor(error) {
  const code = error instanceof ScannerError ? error.code : 'unsupported';
  return ERROR_MESSAGES[code] || ERROR_MESSAGES.unsupported;
}

function showScanError(message) {
  stopScanner();
  scanHint.hidden = true;
  scanErrorText.textContent = message;
  scanErrorBox.hidden = false;
}

function hideScanError() {
  scanErrorBox.hidden = true;
}

function stopScanner() {
  if (scanner) {
    scanner.stop();
    scanner = null;
  }
}

/** Called for every read barcode: buzz, stop the camera, show the sheet. */
function handleDetected(rawValue) {
  const now = Date.now();
  // Ignore an immediate duplicate read right after rescanning.
  if (rawValue === lastDetectedCode && now - lastDetectedAt < 1500) return;

  lastDetectedCode = rawValue;
  lastDetectedAt = now;

  buzz(70); // short haptic feedback where the browser supports it

  stopScanner();
  showResult(rawValue);
}

/* ---------- Result sheet ---------- */

function showResult(code) {
  resultCode.textContent = toPersianDigits(code);
  openSheet(resultSheet, resultBackdrop);
}

function closeResult() {
  closeSheet(resultSheet, resultBackdrop);
}

/* ---------- Manual entry ---------- */

function openManualEntry() {
  manualInput.value = '';
  hideManualError();
  openSheet(manualSheet, manualBackdrop);
  setTimeout(() => manualInput.focus({ preventScroll: true }), 240);
}

function closeManualEntry() {
  manualInput.blur();
  closeSheet(manualSheet, manualBackdrop);
}

function showManualError(message) {
  manualError.textContent = message;
  manualError.hidden = false;
  manualInput.classList.add('is-invalid');
}

function hideManualError() {
  manualError.hidden = true;
  manualInput.classList.remove('is-invalid');
}

/** Validates an 8- or 13-digit barcode and opens the result sheet. */
function submitManualEntry() {
  const digits = toAsciiDigits(manualInput.value).replace(/[\s-]/g, '');

  if (!/^\d+$/.test(digits)) {
    showManualError('فقط عدد وارد کنید.');
    return;
  }
  if (digits.length !== 8 && digits.length !== 13) {
    showManualError('شماره بارکد باید ۸ یا ۱۳ رقم باشد.');
    return;
  }

  hideManualError();
  closeManualEntry();
  lastDetectedCode = digits;
  lastDetectedAt = Date.now();
  showResult(digits);
}

/* ---------- Events ---------- */

function openScanScreen() {
  closeResult();
  showScreen('scan');
  startScanner();
}

function closeScanScreen() {
  stopScanner();
  hideScanError();
  showScreen('home');
}

document.getElementById('btn-start-scan').addEventListener('click', openScanScreen);
document.getElementById('btn-close-scan').addEventListener('click', closeScanScreen);
document.getElementById('btn-scan-error-close').addEventListener('click', closeScanScreen);
document.getElementById('btn-scan-retry').addEventListener('click', startScanner);
document.getElementById('btn-manual-scan').addEventListener('click', openManualEntry);

document.getElementById('btn-rescan').addEventListener('click', () => {
  closeResult();
  openScanScreen();
});
document.getElementById('btn-result-close').addEventListener('click', closeResult);
resultBackdrop.addEventListener('click', closeResult);

document.getElementById('btn-manual-submit').addEventListener('click', submitManualEntry);
document.getElementById('btn-manual-cancel').addEventListener('click', closeManualEntry);
manualBackdrop.addEventListener('click', closeManualEntry);

manualInput.addEventListener('input', hideManualError);
manualInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitManualEntry();
});

navItems.forEach((item) => {
  item.addEventListener('click', () => {
    const target = item.dataset.nav;
    if (target === 'scan') {
      openScanScreen();
      return;
    }
    stopScanner();
    hideScanError();
    showScreen(target);
  });
});

// Leaving the page must never keep the camera running; coming back to an
// idle scan screen resumes it automatically.
document.addEventListener('visibilitychange', () => {
  const onScanScreen = screens.scan.classList.contains('screen--active');
  if (document.hidden) {
    stopScanner();
    return;
  }
  if (onScanScreen && resultSheet.hidden && scanErrorBox.hidden && !scanner) {
    startScanner();
  }
});

window.addEventListener('pagehide', stopScanner);

/* ---------- Install experience ---------- */

const installButton = document.getElementById('btn-install');
const installHint = document.getElementById('install-hint');
const HINT_DISMISSED_KEY = 'salamat-install-hint-dismissed';

// Android / Chrome: capture the prompt so it can be shown from our own button.
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  // Chrome fires this only when the app is genuinely installable.
  event.preventDefault();
  deferredInstallPrompt = event;
  installButton.hidden = false;
  // The iOS-style instructions are pointless next to a native install button.
  hideInstallHint();
});

installButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  try {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
  } catch (error) {
    // Prompt unavailable, already consumed, or the user cancelled.
  }
  deferredInstallPrompt = null;
  installButton.hidden = true;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installButton.hidden = true;
  hideInstallHint();
});

function hideInstallHint() {
  installHint.hidden = true;
}

/**
 * iOS (and in-app browsers) cannot show a native install prompt:
 * show dismissible Persian instructions instead, once.
 */
function maybeShowInstallHint() {
  if (isStandalone()) return;
  if (deferredInstallPrompt) return;

  // In-app browsers (Instagram/Facebook/Telegram webviews) are not Safari and
  // cannot add a home-screen icon — the hint tells the user to open Safari.
  const isSafari =
    !IS_IOS ||
    (/Safari/.test(navigator.userAgent) &&
      !/CriOS|FxiOS|EdgiOS|OPiOS|Android/.test(navigator.userAgent));
  if (IS_IOS && !isSafari && !('standalone' in navigator)) {
    showInstallHint();
    return;
  }

  if (IS_IOS && !localStorage.getItem(HINT_DISMISSED_KEY)) showInstallHint();
}

function showInstallHint() {
  installHint.hidden = false;
}

document.getElementById('btn-install-hint-close').addEventListener('click', () => {
  hideInstallHint();
  try {
    localStorage.setItem(HINT_DISMISSED_KEY, '1');
  } catch (error) {
    // Private mode: the hint simply reappears next visit.
  }
});

// Give the browser a moment to fire beforeinstallprompt before deciding.
window.addEventListener('load', () => {
  setTimeout(maybeShowInstallHint, 600);
});

/* ---------- Service worker (offline app shell) ---------- */

if ('serviceWorker' in navigator && window.isSecureContext) {
  // Relative path keeps the SW scope correct under a GitHub Pages sub-path.
  navigator.serviceWorker.register('./service-worker.js').catch(() => {
    // Offline support is a progressive enhancement; ignore failures.
  });
}

/* ---------- Boot ---------- */

showScreen('home');
