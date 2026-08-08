import { translations, interpolate } from './i18n.js';
import { proxyLine } from './format.js';
import { parseProxyList, proxyKey, isAcceptedFilename } from './parse.js';
import { createSSEParser } from './sse.js';
import {
    renderResultsTable,
    renderStats as renderStatTiles,
    setResultsView as applyResultsView,
    showToast as paintToast,
} from './render.js';
import { createScanState } from './state.js';

// All mutable scan state lives here; nothing below declares its own.
const state = createScanState();

let currentTheme = localStorage.getItem('theme') || 'dark';

function setTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

let currentLang = localStorage.getItem('lang') || 'fa';

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('lang', lang);
    
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
    document.getElementById('langSelect').value = lang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[lang][key]) {
            if (el.id === 'startBtn') return;
            el.innerText = translations[lang][key];
        }
    });

    document.getElementById('inputProxies').placeholder = translations[lang].inputPlaceholder;
    document.getElementById('outputProxies').placeholder = translations[lang].outputPlaceholder;
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
    if (state.scanState === 'scanning') updateScanSummary();
    scheduleResultsRender();
}

setLanguage(currentLang);
setTheme(currentTheme);
updateStartBtn();

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
    localStorage.setItem('concurrency', document.getElementById('concurrencySelect').value);
    localStorage.setItem('timeout', document.getElementById('timeoutSelect').value);
}

function loadSettings() {
    // Migrate to v3 defaults: timeout=5, concurrency=50
    if (!localStorage.getItem('settings_v') || localStorage.getItem('settings_v') < '3') {
        localStorage.removeItem('timeout');
        localStorage.removeItem('concurrency');
        localStorage.setItem('settings_v', '3');
    }
    const c = localStorage.getItem('concurrency');
    const t = localStorage.getItem('timeout');
    if (c) document.getElementById('concurrencySelect').value = c;
    if (t) document.getElementById('timeoutSelect').value = t;
}

document.getElementById('concurrencySelect').addEventListener('change', saveSettings);
document.getElementById('timeoutSelect').addEventListener('change', saveSettings);
loadSettings();

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

    const body = proxies.map(p => ({
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
                        state.workingProxies.push({ link: orig, ping: data.ping, server: data.server, port: data.port });
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
    if (localStorage.getItem('soundEnabled') === 'true') soundCheck.checked = true;
    syncSoundUI();
    soundCheck.addEventListener('change', () => {
        localStorage.setItem('soundEnabled', soundCheck.checked);
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
document.getElementById('viewTableBtn').addEventListener('click', () => applyResultsView(document, 'table'));
document.getElementById('viewTextBtn').addEventListener('click', () => applyResultsView(document, 'text'));
document.getElementById('copyBtn').addEventListener('click', copyResults);
document.getElementById('exportTxtBtn').addEventListener('click', () => exportResults('txt'));
document.getElementById('exportJsonBtn').addEventListener('click', () => exportResults('json'));
