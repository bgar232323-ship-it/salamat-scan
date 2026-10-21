/**
 * scanner.js — camera and barcode detection logic (no UI code here).
 *
 * Detection order:
 *   1. Native `BarcodeDetector` API when the browser exposes it and it
 *      supports the formats we need.
 *   2. Locally stored ZXing (UMD build), loaded on demand from ./zxing.min.js.
 *
 * Only the required 1D symbologies are enabled:
 * EAN-13, EAN-8, UPC-A, UPC-E and Code 128.
 */

/** Format names used by the native BarcodeDetector API. */
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

/** Minimum delay between two native detections (ms) — keeps CPU use sane. */
const NATIVE_INTERVAL_MS = 180;

/** Path of the locally stored ZXing build, relative to the page. */
const ZXING_URL = './js/zxing.min.js';

/**
 * Error codes surfaced to the UI, which translates them to Persian copy.
 * - insecure: page is not HTTPS/localhost
 * - unsupported: browser has no mediaDevices / no decoder at all
 * - denied: user or policy refused camera permission
 * - nocamera: no usable (rear) camera found
 * - inuse: camera is already used by another application
 */
export class ScannerError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'ScannerError';
    this.code = code;
    this.cause = cause;
  }
}

/** Maps a getUserMedia rejection to one of the stable error codes above. */
function mapMediaError(error) {
  const name = error && error.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'nocamera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'inuse';
    default:
      return 'unsupported';
  }
}

/** True when the page can ask for a camera at all (HTTPS or localhost). */
export function isCameraApiAvailable() {
  return Boolean(
    window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

/** Lazily injects the local ZXing script exactly once. */
let zxingPromise = null;
function loadZXing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (zxingPromise) return zxingPromise;

  zxingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ZXING_URL;
    script.async = true;
    script.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing missing')));
    script.onerror = () => reject(new Error('ZXing failed to load'));
    document.head.appendChild(script);
  });

  // Allow a retry after a transient failure.
  zxingPromise.catch(() => {
    zxingPromise = null;
  });
  return zxingPromise;
}

/**
 * Picks the detection engine.
 * Returns 'native', 'zxing' or throws ScannerError('unsupported').
 */
export async function pickEngine() {
  if (typeof window.BarcodeDetector !== 'function') {
    await loadZXing(); // fails fast with a plain Error when unavailable
    return 'zxing';
  }

  // Newer implementations report which symbologies they can decode.
  if (typeof window.BarcodeDetector.getSupportedFormats === 'function') {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const usable = NATIVE_FORMATS.filter((format) => supported.includes(format));
      // Without EAN-13 the native engine cannot serve the main use case.
      if (usable.includes('ean_13')) return 'native';
    } catch (error) {
      // fall through to ZXing
    }
    await loadZXing();
    return 'zxing';
  }

  // Older implementations: probe the constructor instead.
  try {
    // eslint-disable-next-line no-new
    new window.BarcodeDetector({ formats: NATIVE_FORMATS });
    return 'native';
  } catch (error) {
    await loadZXing();
    return 'zxing';
  }
}

/**
 * Owns the camera stream and the decoding loop.
 *
 *   const scanner = new BarcodeScanner(videoEl, { onDetect: (text) => {} });
 *   await scanner.start();
 *   scanner.stop();
 */
export class BarcodeScanner {
  constructor(videoElement, { onDetect, onError } = {}) {
    this.video = videoElement;
    this.onDetect = onDetect || (() => {});
    this.onError = onError || (() => {});
    this.stream = null;
    this.engine = null;
    this.reader = null; // ZXing reader instance
    this.detector = null; // native BarcodeDetector instance
    this.active = false;
    this.rafId = 0;
    this.lastDetectAt = 0;
    this.detecting = false;
    this.engineFallbackTried = false;
  }

  /** Requests the rear camera and starts decoding. Rejects with ScannerError. */
  async start() {
    if (this.active) return;

    if (!isCameraApiAvailable()) {
      throw new ScannerError(window.isSecureContext ? 'unsupported' : 'insecure');
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      throw new ScannerError(mapMediaError(error), error);
    }

    this.stream = stream;
    this.video.srcObject = stream;

    try {
      await this.video.play();
    } catch (error) {
      // Autoplay of a muted video is normally allowed; ignore hiccups.
    }

    this.active = true;

    try {
      this.engine = await pickEngine();
    } catch (error) {
      this.stop();
      throw new ScannerError('unsupported', error);
    }

    if (this.engine === 'native') {
      this.startNativeLoop();
    } else {
      await this.startZxingLoop();
    }
  }

  /** Native path: throttle BarcodeDetector.detect() with requestAnimationFrame. */
  startNativeLoop() {
    try {
      this.detector = new window.BarcodeDetector({ formats: NATIVE_FORMATS });
    } catch (error) {
      // Constructor rejected the formats: switch to the local ZXing build.
      this.engineFallbackTried = true;
      loadZXing()
        .then(() => this.startZxingLoop())
        .catch((loadError) => this.onFatal('unsupported', loadError));
      return;
    }

    const tick = async (now) => {
      if (!this.active) return;

      if (!this.detecting && now - this.lastDetectAt >= NATIVE_INTERVAL_MS) {
        this.detecting = true;
        this.lastDetectAt = now;
        try {
          const codes = await this.detector.detect(this.video);
          const code = codes && codes[0];
          if (code && this.active) {
            this.handleResult(code.rawValue);
          }
        } catch (error) {
          // A detector that cannot decode our formats at all is a real failure;
          // anything else (busy frame) is transient and simply retried.
          const message = String((error && error.message) || '').toLowerCase();
          if (!this.engineFallbackTried && /format|support/.test(message)) {
            this.engineFallbackTried = true;
            this.detector = null;
            loadZXing()
              .then(() => this.startZxingLoop())
              .catch((loadError) => this.onFatal('unsupported', loadError));
            return;
          }
        } finally {
          this.detecting = false;
        }
      }

      if (this.active) this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  /** Fallback path: ZXing decodes our own MediaStream continuously. */
  async startZxingLoop() {
    if (!this.active) return;

    const ZXing = await loadZXing().catch((error) => {
      this.onFatal('unsupported', error);
      return null;
    });
    if (!ZXing || !this.active) return;

    const { BarcodeFormat, DecodeHintType } = ZXing;
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
    ]);

    this.reader = new ZXing.BrowserMultiFormatReader(hints, 250);

    try {
      // decodeFromStream reuses the stream we already opened, so error mapping
      // and camera shutdown stay under our control.
      this.reader
        .decodeFromStream(this.stream, this.video, (result) => {
          if (result && this.active) this.handleResult(result.getText());
        })
        .catch((error) => {
          if (this.active) this.onFatal('unsupported', error);
        });
    } catch (error) {
      this.onFatal('unsupported', error);
    }
  }

  /** Reports a fatal engine failure once, then shuts the camera down. */
  onFatal(code, cause) {
    if (!this.active) return;
    this.stop();
    this.onError(new ScannerError(code, cause));
  }

  /** Normalises a raw value and forwards the first accepted read. */
  handleResult(rawValue) {
    const text = String(rawValue || '').trim();
    if (!text || !this.active) return;
    const detect = this.onDetect;
    this.stop(); // stop the camera before the UI reacts
    detect(text);
  }

  /** Stops decoding and releases every camera track. Safe to call repeatedly. */
  stop() {
    this.active = false;

    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    if (this.reader) {
      try {
        this.reader.reset(); // also stops the stream attached by ZXing
      } catch (error) {
        // ignore — we stop the tracks ourselves below
      }
      this.reader = null;
    }

    this.detector = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch (error) {
          // ignore
        }
      }
      this.stream = null;
    }

    if (this.video) {
      this.video.srcObject = null;
    }
  }
}
