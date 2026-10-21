# سالامت اسکن — Salamat Scan

A mobile-first PWA that scans food barcodes. **Step 1: project skeleton + barcode scanner only.**

- Plain HTML / CSS / vanilla JavaScript (ES modules). No framework, no build step, no npm.
- **No external CDNs or remote resources.** Every library and font is stored in this folder, so the
  app works where CDNs are blocked.
- RTL (`dir="rtl"`, `lang="fa"`), Persian digits in the UI, Vazirmatn served locally.
- Installable on **iOS 16+ (Safari)** and **Android (Chrome)**, ready for GitHub Pages.

## File structure

```
index.html            app shell (home / scan / history screens, sheets, install hint, bottom nav)
manifest.webmanifest  PWA manifest — relative start_url/scope so sub-paths work
service-worker.js     caches the app shell for offline use (versioned cache, relative paths)
css/style.css         mobile-first styles, light + dark mode, safe areas, reduced motion
js/app.js             UI logic (navigation, sheets, validation, install prompts, service worker)
js/scanner.js         camera + barcode detection logic
js/zxing.min.js       local ZXing build used when BarcodeDetector is missing (all iOS browsers)
fonts/                Vazirmatn woff2 (Regular, Medium, Bold)
icons/                PWA icons 180 (apple-touch-icon), 192, 512
tools/make_icons.py   regenerates the icons (stdlib only)
.nojekyll             tells GitHub Pages not to run Jekyll
README.md
```

## Run it locally

Camera access requires a **secure context**: `https://` or `localhost`.

```bash
cd salamat-scan
python -m http.server 8000
# then open http://localhost:8000
```

Any other static server works too (`npx serve`, `php -S localhost:8000`, …).

## Deploy on GitHub Pages

All asset paths in this project are **relative** (`./index.html`, `start_url: "./"`,
`scope: "./"`, `register('./service-worker.js')`), so the app works at the repository sub-path
`username.github.io/repo-name/` without any configuration.

1. **Create the repository**

   ```bash
   # on github.com → New repository → name: salamat-scan → Public → Create
   ```

2. **Push the project**

   ```bash
   cd salamat-scan
   git init -b main
   git add .
   git commit -m "Salamat Scan: installable barcode scanner PWA"
   git remote add origin https://github.com/<username>/salamat-scan.git
   git push -u origin main
   ```

3. **Enable Pages**

   - Repo → **Settings** → **Pages**
   - *Source*: **Deploy from a branch**
   - *Branch*: **main**, folder: **/ (root)** → **Save**

4. Wait for the green check, then open `https://<username>.github.io/salamat-scan/`.
   GitHub Pages already serves over HTTPS, which the camera API requires.

5. `.nojekyll` is included so GitHub Pages serves the files byte-for-byte (no Jekyll pass).

> After changing shell files, bump `SHELL_VERSION` in `service-worker.js`, push, and hard-refresh
> clients — otherwise phones keep serving the cached previous version.

### Install on iPhone (Safari, iOS 16+)

1. Open the URL in **Safari** (a share-sheet install is impossible in Chrome/Firefox or inside
   Instagram/Telegram/Facebook webviews — the app shows a Persian hint telling you this).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch from the icon: it opens standalone, without Safari chrome.

### Install on Android (Chrome)

1. Open the URL in Chrome.
2. Either tap the custom **نصب برنامه** button on the home screen (shown once Chrome fires
   `beforeinstallprompt`), or Chrome menu → **Install app** / **Add to Home screen**.

## Testing checklist

- [ ] **Camera permission** — tapping **اسکن بارکد** (and only that tap) starts the camera and
      prompts for permission; denying shows the Persian message with **تلاش دوباره**, never a blank
      screen.
- [ ] **Scan a real EAN-13 barcode** — phone buzzes (Android), camera stops, the number slides up
      as Persian digits with **اسکن دوباره** / **بستن**.
- [ ] **Manual entry** — 8 or 13 digits accepted, anything else rejected in Persian, no keyboard
      auto-zoom when focusing the field.
- [ ] **Offline launch after install** — enable airplane mode, launch from the home-screen icon:
      the app shell, font, icons and ZXing all load from cache.
- [ ] **Rotate screen** — portrait and landscape both render correctly; no overlap with the notch
      or the iPhone home indicator (bottom nav keeps its `env(safe-area-inset-bottom)` space).
- [ ] **Standalone mode launch** — icon, Persian name and theme colour are correct; the install
      hint no longer appears once running standalone.
- [ ] **Android install** — **نصب برنامه** appears, the Chrome prompt completes, the app opens
      standalone afterwards.
- [ ] **iOS hint** — dismissible, remembered across reloads, hidden in standalone mode.

## Test on a phone before deploying

`localhost` is secure only when the phone itself opens it, so for a real device you need HTTPS.
Easiest options:

1. **Tunnel (quickest):** `ngrok http 8000` or `cloudflared tunnel --url http://localhost:8000`,
   then open the printed `https://…` URL on the phone.
2. **Same machine:** open `http://localhost:8000` in a browser on the computer and use
   `chrome://inspect` remote debugging for a plugged-in Android phone.
3. **LAN + your own certificate:** serve over HTTPS on the LAN if you already have a cert.

## How detection works

`js/scanner.js` picks an engine at runtime:

1. **Native `BarcodeDetector`** when the browser has it *and* reports `ean_13` support.
   Safari (all iOS versions) never has it, so iOS always takes route 2 automatically.
2. **Local ZXing** (`js/zxing.min.js`, loaded on demand) — same camera stream, same five
   symbologies (EAN-13, EAN-8, UPC-A, UPC-E, Code 128) via `DecodeHintType.POSSIBLE_FORMATS`.

The `<video>` carries `playsinline`, `autoplay` and `muted`, and the stream is only requested
inside a click/tap handler (required by iOS). Vibration is behind a `typeof navigator.vibrate`
check plus try/catch, since iOS Safari does not implement it.

Errors are mapped to stable codes (`insecure`, `unsupported`, `denied`, `nocamera`, `inuse`) and
rendered as friendly Persian messages — never a blank screen.

## Notes

- Camera errors: permission denied, no camera, busy camera, insecure origin and unsupported
  browser each get their own Persian message with a retry action.
- The stream is released in `BarcodeScanner.stop()`: leaving the scan screen, switching tabs,
  closing the sheet, or `pagehide` all stop every track.
- Inputs stay at 18px so iOS Safari never auto-zooms; the UI is `user-select: none` and
  `overscroll-behavior: none`, while entered/displayed codes remain selectable.
- Red / yellow / green are intentionally unused here; they are reserved for future score results.
