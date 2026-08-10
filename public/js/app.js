import { translations, interpolate } from './i18n.js';
import { proxyLine } from './format.js';
import { parseProxyList, proxyKey, isAcceptedFilename } from './parse.js';
import { createSSEParser } from './sse.js';
import {
    renderResultsTable,
    renderSourceRows,
    renderStats as renderStatTiles,
    setResultsView as applyResultsView,
    showToast as paintToast,
} from './render.js';
import { createScanState } from './state.js';
import { parseSnapshot } from './snapshot.js';
import {
    addSource,
    defaultSources,
    dropDisabledSources,
    orderForScan,
    parseSources,
    rateBySourceId,
    recordScan,
    removeSource,
    serializeSources,
    setEnabled,
    shortUrl,
    SNAPSHOT_SOURCE_URL,
} from './sources.js';

// All mutable scan state lives here; nothing below declares its own.
const state = createScanState();

// This file is a module, so a throw at top level aborts evaluation and the
// wiring block never runs -- the page paints normally with every control dead.
// The prelude's only outside input is localStorage, so both accessors are
// total. The <head> bootstrap in index.html guards the same reads for the same
// reason; keep the two in step.
function readStored(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;   // storage denied: the defaults stand
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Denied or over quota. The preference does not survive the tab, but
        // losing it must not cost the user the change they just made.
    }
}

function removeStored(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        // Nothing to migrate away from.
    }
}

// localStorage is keyed by origin and this app lives on 127.0.0.1:3000, which it
// shares with every other local dev server. An unrecognised `lang` written by
// one of them is a matter of time, so resolution is total rather than trusting
// the stored value to be a key of translations.
function resolveLang(lang) {
    return translations[lang] ? lang : 'fa';
}

let currentTheme = readStored('theme') || 'dark';

function setTheme(theme) {
    currentTheme = theme;
    writeStored('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

let currentLang = resolveLang(readStored('lang'));

function setLanguage(lang) {
    lang = resolveLang(lang);
    currentLang = lang;
    writeStored('lang', lang);

    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
    document.getElementById('langSelect').value = lang;

    // resolveLang() above guarantees this is a real table, which is what keeps
    // every other translations[currentLang] lookup in this file total too.
    const table = translations[lang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (table[key]) {
            if (el.id === 'startBtn') return;
            el.innerText = table[key];
        }
    });

    document.getElementById('inputProxies').placeholder = table.inputPlaceholder;
    document.getElementById('outputProxies').placeholder = table.outputPlaceholder;
    document.getElementById('sourceUrlInput').placeholder = table.sourceUrlPlaceholder;
}

function updatePauseBtn() {
    const btn = document.getElementById('pauseBtn');
    if (!btn) return;
    const t = translations[currentLang];
    btn.textContent = state.isPaused ? t.resumeBtn : t.pauseBtn;
    btn.className = 'btn-pause' + (state.isPaused ? ' resume' : '');
}

function updateStartBtn() {
    const btn = document.getElementById('startBtn');
    const t = translations[currentLang];
    const idle = state.scanState === 'idle';
    btn.innerText = idle ? t.startBtn : t.stopBtn;
    btn.className = idle ? 'btn-start' : 'btn-stop';
    btn.disabled = false;
}

function setScanUI(scanning) {
    document.body.classList.toggle('scanning', scanning);
}

function updateScanSummary() {
    const t = translations[currentLang];
    document.getElementById('inputSummary').textContent = interpolate(t.summaryLoaded, {
        n: state.allProxies.length,
        m: state.lastSkipped
    });
}

function changeLanguage(lang) {
    setLanguage(lang);
    updatePauseBtn();
    updateStartBtn();
    renderSnapshotMeta();
    renderSources();
    if (state.scanState === 'scanning') updateScanSummary();
    scheduleResultsRender();
}

const MAX_LOG_LINES = 200;

// kind: true|'error' → red, 'ok' → green, anything else → plain
function log(msg, kind = null) {
    const isError = kind === true || kind === 'error';
    const c = document.getElementById('console');
    const line = document.createElement('div');
    line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (isError) line.className = 'error-log';
    else if (kind === 'ok') line.className = 'ok-log';
    if (isError) {
        const drawer = document.getElementById('consoleDrawer');
        if (drawer) drawer.open = true;
    }
    c.appendChild(line);
    while (c.children.length > MAX_LOG_LINES) {
        c.removeChild(c.firstChild);
    }
    c.scrollTop = c.scrollHeight;
}

window.onerror = function(message) {
    log(`CRITICAL ERROR: ${message}`, true);
};

function getConcurrency() {
    return parseInt(document.getElementById('concurrencySelect').value) || 50;
}

function getTimeout() {
    return parseInt(document.getElementById('timeoutSelect').value) || 5;
}

function saveSettings() {
    writeStored('concurrency', document.getElementById('concurrencySelect').value);
    writeStored('timeout', document.getElementById('timeoutSelect').value);
}

function loadSettings() {
    // Migrate to v3 defaults: timeout=5, concurrency=50
    if (!readStored('settings_v') || readStored('settings_v') < '3') {
        removeStored('timeout');
        removeStored('concurrency');
        writeStored('settings_v', '3');
    }
    const c = readStored('concurrency');
    const timeout = readStored('timeout');
    if (c) document.getElementById('concurrencySelect').value = c;
    if (timeout) document.getElementById('timeoutSelect').value = timeout;
}

document.getElementById('concurrencySelect').addEventListener('change', saveSettings);
document.getElementById('timeoutSelect').addEventListener('change', saveSettings);

function openHelp() {
    const urls = {
        fa: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_FA.md',
        en: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README.md',
        ru: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_RU.md',
        zh: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_ZH.md'
    };
    window.open(urls[currentLang] || urls.en, '_blank', 'noopener');
}

function handleStartStop() {
    if (state.scanState === 'idle') startCheck();
    else stopScan();
}

function abortInFlight() {
    if (state.currentController) {
        state.currentController.abort();
        state.currentController = null;
    }
}

// Return the chrome to its pre-scan state: Start button, input pane restored,
// pause hidden. Does not touch results — those survive a stop.
function resetScanUI() {
    state.scanState = 'idle';
    state.isPaused = false;
    updateStartBtn();
    setScanUI(false);
    document.getElementById('pauseBtn').style.display = 'none';
}

function reportScanFailure(err) {
    log(`MAIN ERROR: ${err.message}`, true);
    alert(translations[currentLang].errorGeneric);
    resetScanUI();
}

function stopScan() {
    abortInFlight();
    resetScanUI();
    log('STOPPED');
}

function togglePause() {
    state.isPaused = !state.isPaused;
    if (state.isPaused) {
        abortInFlight();
        updatePauseBtn();
        log('PAUSED');
        return;
    }

    updatePauseBtn();
    log('RESUMED');
    const remaining = state.allProxies.filter(p => !state.checkedKeys.has(proxyKey(p)));
    if (remaining.length === 0) {
        finish();
        return;
    }
    log(`Resuming with ${remaining.length} unchecked...`);
    runCheckStream(remaining, state.globalLinkMap).then(r => {
        if (r === 'done' || r === 'timeout') finish();
    }).catch(reportScanFailure);
}

async function runCheckStream(proxies, linkMap) {
    if (proxies.length === 0) return 'done';

    const controller = new AbortController();
    state.currentController = controller;
    const baseline = state.checkedKeys.size;
    const totalOrig = state.allProxies.length;
    const batchSize = getConcurrency();
    const timeoutSec = getTimeout();
    let scanDone = false;

    // Scan order is file order on the server, so the ranking is applied here, where the body
    // is built -- not to the textarea, which stays exactly as the user (or the snapshot) left it.
    const ordered = orderForScan(proxies, {
        attribution: state.snapshotAttribution,
        rates: rateBySourceId(sources, snapshotSourceUrls),
    });

    const body = ordered.map(p => ({
        server: p.server, port: p.port, secret: p.secret, timeout: timeoutSec
    }));

    const scanTimeout = (timeoutSec + 30) * 1000 + 120000;
    const timeoutId = setTimeout(() => controller.abort(), scanTimeout);

    try {
        const response = await fetch('/check-stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Concurrency': String(batchSize)
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) throw new Error('Server error');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSSEParser();

        while (!scanDone) {
            const { done, value } = await reader.read();
            if (done) break;

            for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
                const data = JSON.parse(frame.data);

                if (frame.event === 'done') {
                    scanDone = true;
                    break;
                }

                if (frame.event === 'progress') {
                    const currentTotal = baseline + data.completed;
                    updateUI(currentTotal, totalOrig);

                    const key = proxyKey(data);
                    state.checkedKeys.add(key);

                    if (data.ok) {
                        const orig = linkMap.get(key) || `tg://proxy?server=${data.server}&port=${data.port}&secret=${data.secret}`;
                        const found = { link: orig, ping: data.ping, server: data.server, port: data.port };
                        // srcs is present only for a link the snapshot published; a pasted
                        // proxy has no source to credit, and Decision 6 keeps the field out
                        // of every export regardless.
                        const meta = state.snapshotAttribution.get(key);
                        if (meta) found.srcs = meta.srcs;
                        state.workingProxies.push(found);
                        log(`SUCCESS: ${data.server} (${data.ping}ms)`, 'ok');
                        updateOutput();
                    }
                }
            }
        }

        return 'done';
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            if (state.isPaused) return 'paused';
            // stopScan() sets scanState = 'idle' synchronously before this abort rejection's
            // microtask runs, so scanState === 'idle' here means the user stopped the scan
            // (as opposed to the scanTimeout watchdog firing while still 'scanning').
            return state.scanState === 'idle' ? 'stopped' : 'timeout';
        }
        throw err;
    }
}

async function startCheck() {
    try {
        const t = translations[currentLang];
        const input = document.getElementById('inputProxies').value;

        if (!input) return showToast(t.toastEmpty, true);

        state.isPaused = false;
        state.currentController = null;
        state.checkedKeys = new Set();
        state.allProxies = [];

        const { proxies: validLinks, skipped, duplicates } = parseProxyList(input);
        state.lastSkipped = skipped;
        if (duplicates > 0) log(`Removed ${duplicates} duplicate entries.`);

        if (validLinks.length === 0) {
            showToast(t.toastNoValid, true);
            log('Error: No valid links parsed', true);
            return;
        }

        log(`Parsed ${validLinks.length} valid links. Skipped ${state.lastSkipped} bad links.`);

        state.workingProxies = [];
        document.getElementById('outputProxies').value = '';
        scheduleResultsRender();

        log(`Settings: concurrency=${getConcurrency()}, timeout=${getTimeout()}s`);

        state.scanState = 'scanning';
        updateStartBtn();
        updatePauseBtn();
        document.getElementById('pauseBtn').style.display = '';

        // Build lookup: "server:port:secret" → original link
        state.globalLinkMap = new Map();
        for (const p of validLinks) {
            state.globalLinkMap.set(proxyKey(p), p.original);
        }

        state.allProxies = validLinks;

        setScanUI(true);
        updateScanSummary();
        updateUI(0, validLinks.length);

        const result = await runCheckStream(state.allProxies, state.globalLinkMap);
        if (result === 'done' || result === 'timeout') {
            if (result === 'timeout') {
                updateUI(state.allProxies.length, state.allProxies.length);
            }
            finish();
        }
        // result === 'paused' → togglePause handles resume
    } catch (e) {
        reportScanFailure(e);
    }
}

function updateUI(c, t) {
    state.lastChecked = c;
    state.lastTotal = t;
    const percent = t ? (c / t) * 100 : 0;
    document.getElementById('progressBar').style.width = percent + '%';
    renderStats();
}

// workingProxies is kept sorted ascending by ping, so the head is the best one.
function renderStats() {
    renderStatTiles(document, {
        checked: state.lastChecked,
        total: state.lastTotal,
        working: state.workingProxies.length,
        best: state.workingProxies.length ? state.workingProxies[0].ping : null,
        skipped: state.lastSkipped,
    });
}

function updateOutput() {
    state.workingProxies.sort((a, b) => a.ping - b.ping);
    document.getElementById('outputProxies').value = state.workingProxies.map(proxyLine).join('\n\n');
    scheduleResultsRender();
    renderStats();
}

let resultsRenderQueued = false;
function scheduleResultsRender() {
    if (resultsRenderQueued) return;
    resultsRenderQueued = true;
    requestAnimationFrame(() => {
        resultsRenderQueued = false;
        renderResultsTable(document, state.workingProxies, translations[currentLang].rowCopy);
    });
}

document.getElementById('resultsBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.rowcopy');
    if (!btn) return;
    const p = state.workingProxies[Number(btn.dataset.index)];
    if (p) copyText(proxyLine(p));
});

function finish() {
    const t = translations[currentLang];
    resetScanUI();
    creditSources();
    log('Process finished.');

    if (state.workingProxies.length > 0) {
        showToast(interpolate(t.toastFound, { n: state.workingProxies.length }));
        if (document.getElementById('soundCheck').checked) beep();
    } else {
        showToast(t.toastNoWorking, true);
    }
}

function copyText(text) {
    const t = translations[currentLang];
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(t.toastCopied);
        }).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function copyResults() {
    const t = translations[currentLang];
    if (state.workingProxies.length === 0) return showToast(t.toastEmpty, true);
    copyText(state.workingProxies.map(proxyLine).join('\n\n'));
}

function fallbackCopy(text) {
    const t = translations[currentLang];
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed"; 
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        showToast(t.toastCopied);
    } catch (err) {
        showToast('Error!', true);
    }
    document.body.removeChild(textArea);
}

function showToast(message, isError = false) {
    paintToast(document, message, isError);
}

function beep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        const now = ctx.currentTime;
        osc.frequency.setValueAtTime(660, now);
        osc.frequency.setValueAtTime(880, now + 0.15);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.6);
    } catch (e) { /* audio not available */ }
}

function syncSoundUI() {
    const el = document.getElementById('soundState');
    const on = document.getElementById('soundCheck').checked;
    el.textContent = on ? 'ON' : 'OFF';
    el.className = 'sound-state ' + (on ? 'on' : 'off');
}

// The list baked into the binary by //go:embed. Fetched, never read from disk, so this
// works the same whether the page is served by `go run .` or by a released binary. It is the
// fallback now, not the first choice: the copy on the `snapshot` branch is rebuilt nightly and
// the baked one is as old as the release.
const SNAPSHOT_URL = '/data/snapshot.txt';

// Every list the server fetches on the page's behalf goes through here.
const FETCH_SOURCES_URL = '/fetch-sources';

// The optional proxy the server retries a failed direct fetch through. → undefined without an
// address, which JSON.stringify drops entirely -- the same thing the server reads as
// direct-only, and one fewer way for a half-filled form to mean something.
//
// The password is kept in localStorage in plaintext, which the drawer says in every locale.
// There is nowhere better: the page has no backend session to hold it in, and the alternative
// is retyping it on every load.
function socks5Config() {
    const addr = document.getElementById('socks5Addr').value.trim();
    if (!addr) return undefined;

    return {
        addr,
        user: document.getElementById('socks5User').value,
        pass: document.getElementById('socks5Pass').value,
    };
}

const SOCKS5_FIELDS = ['socks5Addr', 'socks5User', 'socks5Pass'];

function saveSocks5() {
    for (const id of SOCKS5_FIELDS) writeStored(id, document.getElementById(id).value);
}

function loadSocks5() {
    for (const id of SOCKS5_FIELDS) {
        const stored = readStored(id);
        if (stored !== null) document.getElementById(id).value = stored;
    }
}

// The ISO timestamp off the snapshot header, '' until a load succeeds. Kept here rather
// than in the DOM so a language change can re-render the date in the new locale.
let snapshotGeneratedAt = '';

function renderSnapshotMeta() {
    const el = document.getElementById('snapshotMeta');
    if (!snapshotGeneratedAt) {
        el.textContent = '';
        return;
    }
    const date = new Date(snapshotGeneratedAt);
    // A header this file cannot parse still gets shown -- raw beats blank, and the
    // snapshot's links are unaffected by a malformed timestamp.
    const shown = Number.isNaN(date.getTime())
        ? snapshotGeneratedAt
        : date.toLocaleDateString(currentLang, { year: 'numeric', month: 'long', day: 'numeric' });
    el.textContent = interpolate(translations[currentLang].snapshotDate, { date: shown });
}

// The server fetches on the page's behalf: it can go through a SOCKS5 proxy, and it is not
// bound by CORS. Returns the concatenated text of every source that answered -- a source the
// server could not reach contributes nothing and fails nothing, so an empty body is a real
// answer and not an error.
async function fetchSources(urls) {
    const response = await fetch(FETCH_SOURCES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, socks5: socks5Config() }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

// Steps 1 and 2 of the button: the nightly snapshot, live when the server can reach it and off
// the embed when it cannot. → the parsed snapshot, or null when neither answered with links.
async function loadSnapshotFile() {
    try {
        // parseSnapshot is total, so an unusable body arrives as zero links rather than a
        // throw -- which is still a failed step from the user's point of view.
        const snapshot = parseSnapshot(await fetchSources([SNAPSHOT_SOURCE_URL]));
        if (snapshot.links.length === 0) throw new Error('no links in the live snapshot');
        log(`Loaded ${snapshot.links.length} links from the nightly list.`);
        return snapshot;
    } catch (err) {
        // Logged plainly, not as an error: a network the server cannot cross is the case this
        // whole feature exists for, and the baked copy is about to cover it.
        log(`LIVE SNAPSHOT: ${err.message} — falling back to the built-in copy.`);
    }

    try {
        const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = parseSnapshot(await response.text());
        if (snapshot.links.length === 0) throw new Error('no links in snapshot');
        log(`Loaded ${snapshot.links.length} links from the built-in list.`);
        return snapshot;
    } catch (err) {
        log(`SNAPSHOT ERROR: ${err.message}`, true);
        return null;
    }
}

// Step 3: the sources the user added themselves. The built-ins are what the nightly snapshot is
// built from, so fetching them here would only duplicate it -- a user-added list is the one
// thing no snapshot can carry. → their links as text, '' when there are none or none answered.
async function loadUserSources() {
    const urls = sources.filter(source => source.addedByUser && source.enabled).map(source => source.url);
    if (urls.length === 0) return '';

    try {
        const { proxies } = parseProxyList(await fetchSources(urls));
        log(`Loaded ${proxies.length} links from ${urls.length} of your own sources.`);
        return proxies.map(p => p.original).join('\n');
    } catch (err) {
        // An error, unlike the live-snapshot step: nothing else covers a user's own list, so
        // the drawer opening is the point.
        log(`USER SOURCES: ${err.message}`, true);
        return '';
    }
}

async function loadSnapshot() {
    const t = translations[currentLang];

    // Sequential, in the documented order, so the activity log reads the way the feature is
    // described. Each step is total: a failure is logged and the next one still runs.
    const snapshot = await loadSnapshotFile();
    const userText = await loadUserSources();

    if (snapshot) {
        // Replaced rather than merged: the file just fetched is the whole truth about which
        // sources published what. A failed load keeps the previous map instead.
        state.snapshotAttribution = snapshot.attribution;
        // The header is what joins a `src=` id to a source url, so scoring and scan ordering
        // are both dead until a snapshot has been loaded at least once.
        snapshotSourceUrls = snapshot.sources;
        snapshotGeneratedAt = snapshot.generatedAt;
        renderSnapshotMeta();
    }

    // Deduped as one list rather than concatenated: two lists carrying the same proxy is the
    // ordinary case, and the scan would otherwise be posted the same link twice.
    const { proxies: loaded } = parseProxyList([snapshot ? snapshot.links.join('\n') : '', userText].join('\n'));
    // Applied at load time and nowhere else: after this the textarea is the truth, so a source
    // toggled off later does not reach back into a list the user is looking at.
    const proxies = dropDisabledSources(loaded, {
        attribution: state.snapshotAttribution,
        sources,
        sourceUrls: snapshotSourceUrls,
    });
    const dropped = loaded.length - proxies.length;
    // An error when it emptied the load, since the drawer opening is the only thing that
    // explains a button that appears to have done nothing.
    if (dropped > 0) log(`Dropped ${dropped} links published only by sources you disabled.`, proxies.length === 0);

    if (proxies.length === 0) {
        // The textarea is deliberately left alone: a failed load must not cost the user
        // whatever they had already pasted.
        showToast(t.toastSnapshotFailed, true);
        return;
    }

    document.getElementById('inputProxies').value = proxies.map(p => p.original).join('\n');
    showToast(interpolate(t.toastSnapshotLoaded, { n: proxies.length }));
}

// The source list, and the two things it decides: what the rows say, and what order the next
// scan is posted in. sources.js owns the model and every rule about it; this file owns the
// storage key, the wiring and the localized text -- the same split parse.js and render.js have.
//
// parseSources is total, so a foreign value on this shared origin resolves to the defaults
// rather than throwing out of the module's top level and taking the wiring block with it.
let sources = parseSources(readStored('sources'));

// index -> source url, off the header of the last snapshot loaded. Empty until then, which is
// what makes a pasted-only session score nothing and order nothing.
let snapshotSourceUrls = [];

function persistSources() {
    writeStored('sources', serializeSources(sources));
}

function sourceDetail(source) {
    const t = translations[currentLang];
    // A stored score claiming zero published links is well-formed as far as sources.js is
    // concerned; dividing by it here would put NaN on the page.
    if (!source.score || source.score.linksProvided === 0) return t.sourceUnscored;

    const { linksProvided, linksWorking } = source.score;
    return interpolate(t.sourceScore, {
        n: linksProvided,
        w: linksWorking,
        rate: ((linksWorking / linksProvided) * 100).toFixed(1),
    });
}

function renderSources() {
    renderSourceRows(document, sources.map(source => ({
        url: source.url,
        label: shortUrl(source.url),
        detail: sourceDetail(source),
        enabled: source.enabled,
        removable: source.addedByUser,
    })), translations[currentLang].removeSource);
}

// Every mutation of the list goes through here: the model is immutable, so the new list has to
// be stored and repainted together or the two drift apart.
function applySources(next) {
    sources = next;
    persistSources();
    renderSources();
}

function addSourceFromInput() {
    const field = document.getElementById('sourceUrlInput');
    // addSource ignores a blank and a duplicate on purpose -- both are ordinary typing, not
    // errors worth a toast -- so the field is cleared either way rather than only on success.
    applySources(addSource(sources, field.value));
    field.value = '';

    // The list scrolls at 220px and a new source lands at the bottom of it, so without this the
    // button looks like it did nothing.
    const list = document.getElementById('sourcesList');
    list.scrollTop = list.scrollHeight;
}

// Restores the built-ins *and* drops every score with them: this is the reset, not a
// re-enable. The only irreversible control on the page -- scores accumulate over scans and
// nothing else can rebuild them -- so it is the only one that asks. Logged as well, because it
// is also the one control whose effect is not visible in the row the user clicked.
function restoreSources() {
    if (!confirm(translations[currentLang].confirmRestore)) return;

    applySources(defaultSources());
    log('Source list restored to the built-in defaults.');
}

// Credits every source that published a link this scan, working or not: a list is measured by
// what its links did, and a link that failed is evidence about the list that published it.
// Nothing is credited when no snapshot has been loaded -- a pasted link has no source.
function creditSources() {
    if (snapshotSourceUrls.length === 0) return;

    const provided = [];
    for (const key of state.checkedKeys) {
        const meta = state.snapshotAttribution.get(key);
        if (meta) provided.push(meta.srcs);
    }

    sources = recordScan(sources, {
        sourceUrls: snapshotSourceUrls,
        provided,
        working: state.workingProxies.filter(p => p.srcs).map(p => p.srcs),
        scannedAt: new Date().toISOString(),
    });
    persistSources();
    renderSources();
}

function readProxyFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('inputProxies').value = e.target.result;
        log(`Loaded file: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    };
    reader.readAsText(file);
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    readProxyFile(file);
    event.target.value = '';
}

// Drag & drop onto the input zone feeds the same reader as the file picker.
(function wireDropZone() {
    const pane = document.querySelector('.io-pane');
    if (!pane) return;
    const input = document.getElementById('inputProxies');
    // dragenter/dragleave fire for every child crossing; a depth counter
    // keeps the highlight stable until the pointer truly leaves the pane
    let depth = 0;

    pane.addEventListener('dragenter', (e) => {
        e.preventDefault();
        depth++;
        pane.classList.add('dragover');
    });

    // preventDefault here is what stops the browser from navigating to the
    // dropped file (which would discard the user's pasted list)
    pane.addEventListener('dragover', (e) => e.preventDefault());

    pane.addEventListener('dragleave', () => {
        depth--;
        if (depth <= 0) {
            depth = 0;
            pane.classList.remove('dragover');
        }
    });

    pane.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        pane.classList.remove('dragover');
        const t = translations[currentLang];
        const files = e.dataTransfer.files;

        if (files.length > 1) return showToast(t.toastMultiFile, true);

        if (files.length === 1) {
            if (!isAcceptedFilename(files[0].name)) {
                return showToast(t.toastBadFileType, true);
            }
            return readProxyFile(files[0]);
        }

        // a dragged text selection (e.g. links from another window):
        // preventDefault killed the native insert, so append it ourselves
        const text = e.dataTransfer.getData('text/plain');
        if (text) {
            input.value = input.value ? input.value.replace(/\n?$/, '\n') + text : text;
            log(`Dropped text (${text.length} chars)`);
        }
    });
})();

function exportResults(format) {
    const t = translations[currentLang];
    if (state.workingProxies.length === 0) return showToast(t.toastEmpty, true);

    let content, filename, type;
    if (format === 'json') {
        content = JSON.stringify(state.workingProxies.map(p => ({ link: p.link, ping: p.ping })), null, 2);
        filename = 'proxies.json';
        type = 'application/json';
    } else {
        content = state.workingProxies.map(proxyLine).join('\n\n');
        filename = 'proxies.txt';
        type = 'text/plain';
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t.toastExported || 'Exported!');
}

const soundCheck = document.getElementById('soundCheck');
if (soundCheck) {
    if (readStored('soundEnabled') === 'true') soundCheck.checked = true;
    soundCheck.addEventListener('change', () => {
        writeStored('soundEnabled', soundCheck.checked);
        syncSoundUI();
    });
}

// Every control is bound here rather than through inline onclick/onchange
// attributes in index.html. This file is loaded as a module, and a module's
// top-level scope is not window, so an inline attribute could not reach any of
// these functions. Renaming one now breaks the build loudly instead of silently
// breaking a button.
document.getElementById('themeToggle').addEventListener('click', toggleTheme);
document.getElementById('langSelect').addEventListener('change', (e) => changeLanguage(e.target.value));
document.getElementById('helpBtn').addEventListener('click', openHelp);
document.getElementById('startBtn').addEventListener('click', handleStartStop);
document.getElementById('pauseBtn').addEventListener('click', togglePause);
document.getElementById('fileInput').addEventListener('change', handleFileUpload);
document.getElementById('loadListBtn').addEventListener('click', loadSnapshot);
document.getElementById('viewTableBtn').addEventListener('click', () => applyResultsView(document, 'table'));
document.getElementById('viewTextBtn').addEventListener('click', () => applyResultsView(document, 'text'));
document.getElementById('copyBtn').addEventListener('click', copyResults);
document.getElementById('exportTxtBtn').addEventListener('click', () => exportResults('txt'));
document.getElementById('exportJsonBtn').addEventListener('click', () => exportResults('json'));
// One delegated listener, because renderSources() rebuilds every row wholesale -- the same
// reason the per-row copy button is delegated onto #resultsBody.
for (const id of SOCKS5_FIELDS) {
    document.getElementById(id).addEventListener('change', saveSocks5);
}
document.getElementById('sourcesList').addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    applySources(setEnabled(sources, box.dataset.url, box.checked));
});
document.getElementById('sourcesList').addEventListener('click', (e) => {
    const btn = e.target.closest('.source-remove');
    if (!btn) return;
    applySources(removeSource(sources, btn.dataset.url));
});
document.getElementById('addSourceBtn').addEventListener('click', addSourceFromInput);
document.getElementById('sourceUrlInput').addEventListener('keydown', (e) => {
    // The field is not in a form, so Enter would otherwise do nothing at all.
    if (e.key === 'Enter') addSourceFromInput();
});
document.getElementById('restoreSourcesBtn').addEventListener('click', restoreSources);

// Painting runs last, after every listener above is attached. These walk the
// DOM and read the translation table, so they are the statements most likely to
// throw on a surprising document -- and a throw here now costs the first paint,
// not the entire control surface.
setLanguage(currentLang);
setTheme(currentTheme);
updateStartBtn();
renderSources();
loadSettings();
loadSocks5();
if (soundCheck) syncSoundUI();
