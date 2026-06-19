const translations = {
    fa: {
        title: "MTProto Pro Checker",
        subtitle: "تست اتصال",
        ready: "آماده برای شروع...",
        inputLabel: "📥 لیست ورودی (کثیف و نامرتب)",
        inputPlaceholder: "لینکهای پروکسی را اینجا وارد کنید (هر خط یک لینک)...",
        startBtn: "شروع بررسی",
        pauseBtn: "⏸ توقف موقت",
        resumeBtn: "▶ ادامه",
        outputLabel: "🚀 لیست ۱۰۰٪ سالم",
        outputPlaceholder: "نتایج سالم اینجا نمایش داده میشوند...",
        copyBtn: "کپی کردن لیست سالم",
        processing: "در حال پردازش...",
        status: "وضعیت: {c} / {t} | سالم: {w}",
        toastCopied: "✅ کپی شد!",
        toastEmpty: "⚠️ لیست خالی است!",
        toastNoValid: "⛔ هیچ لینک معتبری یافت نشد!",
        toastNoWorking: "😔 هیچ پروکسی سالمی پیدا نشد.",
        toastFound: "🎉 {n} پروکسی سالم پیدا شد!",
        errorGeneric: "خطایی رخ داد. کنسول را چک کنید.",
        fileBtn: "📎 فایل",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ فایل دانلود شد!",
        concurrencyLabel: "تعداد همزمان",
        timeoutLabel: "تایم‌اوت (ثانیه)"
    },
    en: {
        title: "MTProto Pro Checker",
        subtitle: "Real connection test",
        ready: "Ready to start...",
        inputLabel: "📥 Input List (Mixed/Dirty)",
        inputPlaceholder: "Paste proxy links here (one per line)...",
        startBtn: "Start Check",
        pauseBtn: "⏸ Pause",
        resumeBtn: "▶ Resume",
        outputLabel: "🚀 Working Proxies (100%)",
        outputPlaceholder: "Working proxies will appear here...",
        copyBtn: "Copy Working List",
        processing: "Processing...",
        status: "Status: {c} / {t} | Working: {w}",
        toastCopied: "✅ Copied to clipboard!",
        toastEmpty: "⚠️ List is empty!",
        toastNoValid: "⛔ No valid links found!",
        toastNoWorking: "😔 No working proxies found.",
        toastFound: "🎉 Found {n} working proxies!",
        errorGeneric: "An error occurred. Check console.",
        fileBtn: "📎 File",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ File downloaded!",
        concurrencyLabel: "Concurrent",
        timeoutLabel: "Timeout (sec)"
    }
};

let currentLang = localStorage.getItem('lang') || 'fa';

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('lang', lang);
    
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
    document.getElementById('langSelect').value = lang;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[lang][key]) el.innerText = translations[lang][key];
    });

    document.getElementById('inputProxies').placeholder = translations[lang].inputPlaceholder;
    document.getElementById('outputProxies').placeholder = translations[lang].outputPlaceholder;
}

function updatePauseBtn() {
    const btn = document.getElementById('pauseBtn');
    if (!btn) return;
    const t = translations[currentLang];
    btn.textContent = isPaused ? t.resumeBtn : t.pauseBtn;
    btn.className = 'btn-pause' + (isPaused ? ' resume' : '');
}

function changeLanguage(lang) {
    setLanguage(lang);
    updatePauseBtn();
}

setLanguage(currentLang);

const MAX_LOG_LINES = 200;

function log(msg, isError = false) {
    const c = document.getElementById('console');
    const line = document.createElement('div');
    line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (isError) line.className = 'error-log';
    c.appendChild(line);
    while (c.children.length > MAX_LOG_LINES) {
        c.removeChild(c.firstChild);
    }
    c.scrollTop = c.scrollHeight;
}

window.onerror = function(message) {
    log(`CRITICAL ERROR: ${message}`, true);
};

let workingProxies = [];
let skippedCount = 0;
let isPaused = false;
let pauseResolve = null;

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

function parseLink(link) {
    try {
        let cleanLink = link.trim().replace('.&', '&');
        if(!cleanLink.includes('://')) return null;

        const urlObj = new URL(cleanLink);
        const params = new URLSearchParams(urlObj.search);
        
        const server = params.get('server');
        let port = parseInt(params.get('port'));
        const secret = params.get('secret');

        if (!server || !port || !secret || isNaN(port)) return null;
        if (port <= 0 || port > 65535) return null;

        if (secret.length > 170 || secret.includes('AAAAAAAAAAAAAAAAAAAA')) {
            skippedCount++;
            return null;
        }

        return { server, port, secret, original: cleanLink };
    } catch (e) { return null; }
}

function togglePause() {
    isPaused = !isPaused;
    if (!isPaused && pauseResolve) {
        pauseResolve();
        pauseResolve = null;
    }
    updatePauseBtn();
    log(isPaused ? 'PAUSED' : 'RESUMED');
}

async function startCheck() {
    try {
        const t = translations[currentLang];
        const input = document.getElementById('inputProxies').value;
        
        if (!input) return showToast(t.toastEmpty, true);

        isPaused = false;
        pauseResolve = null;

        const lines = input.split('\n');
        skippedCount = 0;
        let validLinks = lines.map(parseLink).filter(l => l !== null);

        const seen = new Set();
        const deduped = validLinks.filter(p => {
            const key = `${p.server}:${p.port}:${p.secret}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const dupCount = validLinks.length - deduped.length;
        if (dupCount > 0) log(`Removed ${dupCount} duplicate entries.`);
        validLinks = deduped;

        if (validLinks.length === 0) {
            showToast(t.toastNoValid, true);
            log('Error: No valid links parsed', true);
            return;
        }

        log(`Parsed ${validLinks.length} valid links. Skipped ${skippedCount} bad links.`);

        workingProxies = [];
        document.getElementById('outputProxies').value = '';

        let completed = 0;
        const total = validLinks.length;

        const batchSize = getConcurrency();
        const timeoutSec = getTimeout();

        log(`Settings: concurrency=${batchSize}, timeout=${timeoutSec}s`);

        const startBtn = document.getElementById('startBtn');
        const pauseBtn = document.getElementById('pauseBtn');
        startBtn.disabled = true;
        startBtn.innerText = t.processing;
        updatePauseBtn();
        pauseBtn.style.display = '';
        updateUI(0, total);

        // Build lookup: "server:port:secret" → original link
        const linkMap = new Map();
        for (const p of validLinks) {
            linkMap.set(`${p.server}:${p.port}:${p.secret}`, p.original);
        }

        // Send ALL proxies in one SSE streaming request
        const body = validLinks.map(p => ({
            server: p.server, port: p.port, secret: p.secret, timeout: timeoutSec
        }));

        const controller = new AbortController();
        const scanTimeout = (timeoutSec + 30) * 1000 + 120000;
        const timeoutId = setTimeout(() => controller.abort(), scanTimeout);

        let scanDone = false;
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
            let buffer = '';
            while (!scanDone) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse SSE frames
                const frames = buffer.split('\n\n');
                buffer = frames.pop(); // keep incomplete frame

                for (const frame of frames) {
                    if (!frame.trim()) continue;

                    let eventType = '';
                    let dataStr = '';
                    for (const line of frame.split('\n')) {
                        if (line.startsWith('event: ')) eventType = line.slice(7);
                        else if (line.startsWith('data: ')) dataStr = line.slice(6);
                    }
                    if (!dataStr) continue;

                    const data = JSON.parse(dataStr);

                    if (eventType === 'done') {
                        scanDone = true;
                        break;
                    }

                    if (eventType === 'progress') {
                        completed = data.completed;
                        updateUI(completed, total);

                        if (data.ok) {
                            const key = `${data.server}:${data.port}:${data.secret}`;
                            const orig = linkMap.get(key) || `tg://proxy?server=${data.server}&port=${data.port}&secret=${data.secret}`;
                            workingProxies.push({ link: orig, ping: data.ping });
                            log(`SUCCESS: ${data.server} (${data.ping}ms)`);
                            updateOutput();
                        }
                    }
                }
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name !== 'AbortError') {
                throw err;
            }
        }

        if (!scanDone) {
            // timed out or aborted — count remaining as failed
            completed = total;
            updateUI(completed, total);
        }
        finish();
    } catch (e) {
        log(`MAIN ERROR: ${e.message}`, true);
        alert(translations[currentLang].errorGeneric);
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').style.display = 'none';
    }
}

function updateUI(c, t) {
    const percent = (c / t) * 100;
    document.getElementById('progressBar').style.width = percent + '%';
    let statusText = translations[currentLang].status
        .replace('{c}', c)
        .replace('{t}', t)
        .replace('{w}', workingProxies.length);
    document.getElementById('statusText').innerText = statusText;
}

function updateOutput() {
    workingProxies.sort((a, b) => a.ping - b.ping);
    const text = workingProxies
        .map(p => `${p.link} # Ping: ${p.ping}ms`)
        .join('\n\n'); 
    document.getElementById('outputProxies').value = text;
}

function finish() {
    const t = translations[currentLang];
    const startBtn = document.getElementById('startBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    startBtn.disabled = false;
    startBtn.innerText = t.startBtn;
    pauseBtn.style.display = 'none';
    isPaused = false;
    log('Process finished.');
    
    if (workingProxies.length > 0) {
        showToast(t.toastFound.replace('{n}', workingProxies.length));
        if (document.getElementById('soundCheck').checked) beep();
    } else {
        showToast(t.toastNoWorking, true);
    }
}

function copyResults() {
    const t = translations[currentLang];
    const text = document.getElementById("outputProxies").value;
    if (!text) return showToast(t.toastEmpty, true);

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(t.toastCopied);
        }).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
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
    const toast = document.getElementById("toast");
    toast.innerText = message;
    toast.style.backgroundColor = isError ? "#ef4444" : "#10b981";
    toast.className = "toast show";
    setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 3000);
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

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('inputProxies').value = e.target.result;
        log(`Loaded file: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
    };
    reader.readAsText(file);
    event.target.value = '';
}

function exportResults(format) {
    const text = document.getElementById('outputProxies').value;
    if (!text) return showToast(translations[currentLang].toastEmpty, true);

    let content, filename, type;
    if (format === 'json') {
        const lines = text.split('\n\n').filter(l => l.trim());
        const data = lines.map(line => {
            const match = line.match(/(.+?)\s*#\s*Ping:\s*(\d+)ms/);
            return match ? { link: match[1].trim(), ping: parseInt(match[2]) } : { link: line.trim(), ping: null };
        });
        content = JSON.stringify(data, null, 2);
        filename = 'proxies.json';
        type = 'application/json';
    } else {
        content = text;
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
    showToast(translations[currentLang].toastExported || 'Exported!');
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
