// Mounts the real frontend in jsdom for the DOM-level suites.
//
// public/js/app.js is a browser module with top-level side effects: it reads
// localStorage, wires eleven controls and paints the UI the moment it is
// imported. jsdom cannot execute <script type="module">, so the module is
// imported by Node itself and jsdom's window is installed on globalThis first --
// app.js reads bare `document`, `localStorage`, `Node`, `fetch` and friends,
// which in a Node module scope resolve to globalThis.
//
// Every mount gets a fresh module instance through a cache-busting query on the
// import specifier; without it the second mount in a process would reuse the
// first module's already-executed state.
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const HTML_URL = new URL('../../public/index.html', import.meta.url);
const APP_URL = new URL('../../public/js/app.js', import.meta.url);

// Everything app.js (or a module it imports) touches as a bare global. Node
// provides its own URL and Blob, but app.js needs jsdom's -- URL.createObjectURL
// does not exist on Node's URL, and a Node Blob is not what jsdom's anchor and
// FileReader accept.
const GLOBAL_KEYS = [
    'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
    'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'alert',
    'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'MouseEvent',
    'Blob', 'File', 'FileReader', 'DataTransfer', 'URL', 'AudioContext',
    'getComputedStyle', 'setTimeout',
];

let mountCounter = 0;

/**
 * Mount public/index.html + public/js/app.js in a fresh jsdom window.
 *
 * @param {object}   [options]
 * @param {object}   [options.storage]  localStorage entries seeded before app.js boots.
 * @param {Function} [options.fetch]    replaces the default fetch stub, which refuses to dial out.
 * @param {string}   [options.url]      document URL; defaults to the dev server address.
 * @returns {Promise<{window, document, cleanup, flushFrames, pendingFrames, recorded}>}
 */
export async function mountApp({ storage = {}, fetch: fetchImpl, url = 'http://127.0.0.1:3000/' } = {}) {
    const recorded = {
        alerts: [],
        clipboard: [],
        opened: [],
        objectURLs: [],
        fetches: [],
        audioContexts: 0,
        jsdomErrors: [],
    };

    const virtualConsole = new VirtualConsole();
    // jsdom raises "Not implemented: navigation" when exportResults() clicks its
    // download anchor. Record instead of printing, so a real error is still
    // inspectable but the suite output stays readable.
    virtualConsole.on('jsdomError', err => recorded.jsdomErrors.push(err.message));

    const dom = new JSDOM(readFileSync(HTML_URL, 'utf8'), {
        url,
        runScripts: 'dangerously',   // runs the <head> paint-order bootstrap, not the module <script src>
        pretendToBeVisual: false,    // jsdom's own timer-driven rAF would defeat flushFrames()
        virtualConsole,
    });
    const { window } = dom;

    // jsdom does not implement innerText: assigning it creates a plain expando and
    // leaves the element empty. app.js writes through innerText in log(),
    // setLanguage(), updateStartBtn() and showToast(), so without this every one of
    // those writes silently vanishes and tests assert against empty elements.
    // Must be defined before app.js runs.
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; },
        set(value) { this.textContent = value; },
        configurable: true,
    });

    window.localStorage.clear();
    for (const [key, value] of Object.entries(storage)) {
        window.localStorage.setItem(key, String(value));
    }

    // Controllable rAF: rendering is coalesced through requestAnimationFrame, so
    // tests need to decide when a frame happens instead of racing a timer.
    const frames = new Map();
    let nextFrameId = 1;
    let frameTime = 0;
    window.requestAnimationFrame = (cb) => {
        const id = nextFrameId++;
        frames.set(id, cb);
        return id;
    };
    window.cancelAnimationFrame = (id) => { frames.delete(id); };

    // How many callbacks are waiting for the next frame. Coalesced rendering is
    // only observable through this count: N results in one tick must leave one
    // queued callback, not N.
    function pendingFrames() {
        return frames.size;
    }

    // Drains until quiet, so a frame scheduled from inside a frame still runs.
    function flushFrames() {
        let rounds = 0;
        while (frames.size > 0) {
            if (++rounds > 100) throw new Error('requestAnimationFrame did not settle after 100 flushes');
            const due = [...frames.values()];
            frames.clear();
            frameTime += 16;
            for (const cb of due) cb(frameTime);
        }
    }

    Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async (text) => { recorded.clipboard.push(text); } },
        configurable: true,
    });
    // copyText() only takes the clipboard path in a secure context.
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

    window.alert = (message) => { recorded.alerts.push(String(message)); };
    window.open = (target) => { recorded.opened.push(String(target)); return null; };

    let objectURLCounter = 0;
    window.URL.createObjectURL = (blob) => {
        const objectURL = `blob:${url}${++objectURLCounter}`;
        recorded.objectURLs.push({ url: objectURL, blob });
        return objectURL;
    };
    window.URL.revokeObjectURL = () => {};

    window.AudioContext = class {
        constructor() {
            recorded.audioContexts++;
            this.currentTime = 0;
            this.destination = {};
        }
        createOscillator() {
            return {
                connect() {}, start() {}, stop() {}, type: 'sine',
                frequency: { setValueAtTime() {} },
            };
        }
        createGain() {
            return {
                connect() {},
                gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            };
        }
    };
    window.webkitAudioContext = undefined;

    window.fetch = async (target, init) => {
        recorded.fetches.push({ url: String(target), init });
        if (!fetchImpl) throw new Error(`fetch is not stubbed for this mount: ${target}`);
        return fetchImpl(target, init);
    };

    // showToast() and the scan watchdog both schedule timers. Left holding the
    // event loop they would keep the test process alive after the last assertion.
    const nodeSetTimeout = globalThis.setTimeout;
    window.setTimeout = (fn, ms, ...rest) => {
        const handle = nodeSetTimeout(fn, ms, ...rest);
        if (handle && typeof handle.unref === 'function') handle.unref();
        return handle;
    };

    const savedGlobals = new Map();
    for (const key of GLOBAL_KEYS) {
        savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {
            value: window[key],
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    await import(`${APP_URL.href}?mount=${++mountCounter}`);

    let cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;
        for (const [key, descriptor] of savedGlobals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
        try {
            window.localStorage.clear();
        } catch { /* window already torn down */ }
        frames.clear();
        window.close();
    }

    return { window, document: window.document, cleanup, flushFrames, pendingFrames, recorded };
}
