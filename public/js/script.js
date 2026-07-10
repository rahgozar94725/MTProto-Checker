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
        stopBtn: "⛔ توقف کامل",
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
        helpBtn: "📖 راهنما",
        fileBtn: "📎 فایل",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ فایل دانلود شد!",
        concurrencyLabel: "تعداد همزمان",
        timeoutLabel: "تایم‌اوت (ثانیه)",
        channelsLabel: "📡 کانال‌های پراکسی تلگرام (هر خط یک کانال)",
        channelsPlaceholder: "MTProxiess\n@DirectProxy\nhttps://t.me/s/socks5_telegram",
        proxyPlaceholder: "پراکسی برای دور زدن فیلترینگ (اختیاری): socks5://127.0.0.1:10808",
        fetchBtn: "⬇ دریافت پراکسی از کانال‌ها",
        perChannelLabel: "تعداد پراکسی از هر کانال (۰ = همه، جدیدترین‌ها):",
        fetchingBtn: "⏳ در حال دریافت...",
        toastNoChannels: "⚠️ هیچ کانالی وارد نشده است!",
        toastFetched: "✅ {n} پراکسی از کانال‌ها دریافت شد!",
        toastFetchNone: "😔 هیچ پراکسی‌ای در کانال‌ها پیدا نشد.",
        toastFetchError: "⛔ خطا در دریافت از کانال‌ها."
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
        stopBtn: "⛔ Stop",
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
        helpBtn: "📖 Help",
        fileBtn: "📎 File",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ File downloaded!",
        concurrencyLabel: "Concurrent",
        timeoutLabel: "Timeout (sec)",
        channelsLabel: "📡 Telegram proxy channels (one per line)",
        channelsPlaceholder: "MTProxiess\n@DirectProxy\nhttps://t.me/s/socks5_telegram",
        proxyPlaceholder: "Proxy to bypass filtering (optional): socks5://127.0.0.1:10808",
        fetchBtn: "⬇ Fetch proxies from channels",
        perChannelLabel: "Proxies per channel (0 = all, newest):",
        fetchingBtn: "⏳ Fetching...",
        toastNoChannels: "⚠️ No channels entered!",
        toastFetched: "✅ Fetched {n} proxies from channels!",
        toastFetchNone: "😔 No proxies found in channels.",
        toastFetchError: "⛔ Failed to fetch from channels."
    },
    ru: {
        title: "MTProto Pro Checker",
        subtitle: "Проверка соединения",
        ready: "Готов к запуску...",
        inputLabel: "📥 Список прокси (грязный/смешанный)",
        inputPlaceholder: "Вставьте ссылки на прокси (по одной в строке)...",
        startBtn: "Начать проверку",
        pauseBtn: "⏸ Пауза",
        resumeBtn: "▶ Продолжить",
        stopBtn: "⛔ Остановить",
        outputLabel: "🚀 Рабочие прокси (100%)",
        outputPlaceholder: "Рабочие прокси появятся здесь...",
        copyBtn: "Копировать список",
        processing: "Обработка...",
        status: "Статус: {c} / {t} | Работает: {w}",
        toastCopied: "✅ Скопировано!",
        toastEmpty: "⚠️ Список пуст!",
        toastNoValid: "⛔ Не найдено валидных ссылок!",
        toastNoWorking: "😔 Рабочих прокси не найдено.",
        toastFound: "🎉 Найдено {n} рабочих прокси!",
        errorGeneric: "Произошла ошибка. Проверьте консоль.",
        helpBtn: "📖 Помощь",
        fileBtn: "📎 Файл",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ Файл загружен!",
        concurrencyLabel: "Одновременно",
        timeoutLabel: "Тайм-аут (сек)",
        channelsLabel: "📡 Telegram-каналы с прокси (по одному в строке)",
        channelsPlaceholder: "MTProxiess\n@DirectProxy\nhttps://t.me/s/socks5_telegram",
        proxyPlaceholder: "Прокси для обхода блокировки (опц.): socks5://127.0.0.1:10808",
        fetchBtn: "⬇ Получить прокси из каналов",
        perChannelLabel: "Прокси с канала (0 = все, новейшие):",
        fetchingBtn: "⏳ Загрузка...",
        toastNoChannels: "⚠️ Каналы не указаны!",
        toastFetched: "✅ Получено {n} прокси из каналов!",
        toastFetchNone: "😔 Прокси в каналах не найдены.",
        toastFetchError: "⛔ Ошибка получения из каналов."
    },
    zh: {
        title: "MTProto Pro Checker",
        subtitle: "连接测试",
        ready: "准备开始...",
        inputLabel: "📥 输入列表（混合/脏数据）",
        inputPlaceholder: "在此粘贴代理链接（每行一个）...",
        startBtn: "开始检查",
        pauseBtn: "⏸ 暂停",
        resumeBtn: "▶ 继续",
        stopBtn: "⛔ 停止",
        outputLabel: "🚀 可用代理 (100%)",
        outputPlaceholder: "可用代理将显示在此处...",
        copyBtn: "复制可用列表",
        processing: "处理中...",
        status: "状态: {c} / {t} | 可用: {w}",
        toastCopied: "✅ 已复制!",
        toastEmpty: "⚠️ 列表为空!",
        toastNoValid: "⛔ 未找到有效链接!",
        toastNoWorking: "😔 未找到可用代理.",
        toastFound: "🎉 找到 {n} 个可用代理!",
        errorGeneric: "发生错误。请检查控制台。",
        helpBtn: "📖 帮助",
        fileBtn: "📎 文件",
        exportTxtBtn: "💾 TXT",
        exportJsonBtn: "💾 JSON",
        toastExported: "✅ 文件已下载!",
        concurrencyLabel: "并发数",
        timeoutLabel: "超时（秒）",
        channelsLabel: "📡 Telegram 代理频道（每行一个）",
        channelsPlaceholder: "MTProxiess\n@DirectProxy\nhttps://t.me/s/socks5_telegram",
        proxyPlaceholder: "用于绕过封锁的代理（可选）: socks5://127.0.0.1:10808",
        fetchBtn: "⬇ 从频道获取代理",
        perChannelLabel: "每个频道的代理数（0 = 全部，最新）:",
        fetchingBtn: "⏳ 获取中...",
        toastNoChannels: "⚠️ 未输入频道!",
        toastFetched: "✅ 已从频道获取 {n} 个代理!",
        toastFetchNone: "😔 频道中未找到代理.",
        toastFetchError: "⛔ 从频道获取失败."
    }
};

let currentTheme = localStorage.getItem('theme') || 'dark';

function setTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}

function toggleTheme() {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

let currentLang = localStorage.getItem('lang') || 'fa';
let scanState = 'idle'; // 'idle' | 'scanning'

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
    const chEl = document.getElementById('inputChannels');
    if (chEl) chEl.placeholder = translations[lang].channelsPlaceholder;
}

function updatePauseBtn() {
    const btn = document.getElementById('pauseBtn');
    if (!btn) return;
    const t = translations[currentLang];
    btn.textContent = isPaused ? t.resumeBtn : t.pauseBtn;
    btn.className = 'btn-pause' + (isPaused ? ' resume' : '');
}

function updateStartBtn() {
    const btn = document.getElementById('startBtn');
    const t = translations[currentLang];
    if (scanState === 'idle') {
        btn.innerText = t.startBtn;
        btn.className = 'btn-start';
        btn.disabled = false;
    } else {
        btn.innerText = t.stopBtn;
        btn.className = 'btn-stop';
        btn.disabled = false;
    }
}

function changeLanguage(lang) {
    setLanguage(lang);
    updatePauseBtn();
    updateStartBtn();
}

setLanguage(currentLang);
setTheme(currentTheme);
updateStartBtn();

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
let currentController = null;
let checkedKeys = new Set();
let allProxies = [];
let globalLinkMap = new Map();

function getConcurrency() {
    return parseInt(document.getElementById('concurrencySelect').value) || 50;
}

function getTimeout() {
    return parseInt(document.getElementById('timeoutSelect').value) || 10;
}

function saveSettings() {
    localStorage.setItem('concurrency', document.getElementById('concurrencySelect').value);
    localStorage.setItem('timeout', document.getElementById('timeoutSelect').value);
}

function loadSettings() {
    // Migrate to v4 defaults: timeout=10 (5s was too short and wrongly failed
    // slow-but-healthy proxies), concurrency=50
    if (!localStorage.getItem('settings_v') || localStorage.getItem('settings_v') < '4') {
        localStorage.removeItem('timeout');
        localStorage.removeItem('concurrency');
        localStorage.setItem('settings_v', '4');
    }
    const c = localStorage.getItem('concurrency');
    const t = localStorage.getItem('timeout');
    if (c) document.getElementById('concurrencySelect').value = c;
    if (t) document.getElementById('timeoutSelect').value = t;
}

document.getElementById('concurrencySelect').addEventListener('change', saveSettings);
document.getElementById('timeoutSelect').addEventListener('change', saveSettings);
loadSettings();

// Restore the saved MTProto proxy link
const savedProxy = localStorage.getItem('fetchProxy');
if (savedProxy) {
    const pxEl = document.getElementById('tgProxyLink');
    if (pxEl && !pxEl.value) pxEl.value = savedProxy;
}

// ----- Channel list: persistence + de-duplication -----

// channelKey normalizes a channel line (URL / @name / bare name) to a single
// canonical key so duplicates collapse regardless of how they were written.
function channelKey(line) {
    let s = line.trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/^t\.me\//, '').replace(/^telegram\.me\//, '');
    s = s.replace(/^s\//, '').replace(/^@/, '');
    const cut = s.search(/[/?#]/);
    if (cut >= 0) s = s.slice(0, cut);
    return s;
}

// dedupeChannels returns the non-empty channel lines with duplicates removed,
// keeping the first occurrence of each.
function dedupeChannels(raw) {
    const seen = new Set();
    const out = [];
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const key = channelKey(t);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(t);
    }
    return out;
}

function saveChannels() {
    localStorage.setItem('fetchChannels', document.getElementById('inputChannels').value);
}

// Restore the saved channel list and persist edits as the user types.
const channelsEl = document.getElementById('inputChannels');
if (channelsEl) {
    const savedChannels = localStorage.getItem('fetchChannels');
    if (savedChannels && !channelsEl.value.trim()) channelsEl.value = savedChannels;
    channelsEl.addEventListener('input', saveChannels);
}

// Restore the saved per-channel proxy count.
const perChannelEl = document.getElementById('tgPerChannel');
if (perChannelEl) {
    const savedPerChannel = localStorage.getItem('tgPerChannel');
    if (savedPerChannel) perChannelEl.value = savedPerChannel;
}

function parseLink(link) {
    try {
        let cleanLink = link.trim().replace('.&', '&');
        if(!cleanLink.includes('://')) return null;

        const urlObj = new URL(cleanLink);
        const params = new URLSearchParams(urlObj.search);

        const server = params.get('server');
        let port = parseInt(params.get('port'));
        // Read `secret` straight from the raw query, NOT via URLSearchParams:
        // a base64-standard secret can contain '+', and URLSearchParams decodes
        // '+' to a space (per the form-encoding spec), which corrupts the secret
        // and makes a perfectly good proxy fail the check. The link is otherwise
        // un-encoded, so a direct regex grab is safe.
        const secretMatch = urlObj.search.match(/[?&]secret=([^&]+)/i);
        const secret = secretMatch ? secretMatch[1] : null;

        if (!server || !port || !secret || isNaN(port)) return null;
        if (port <= 0 || port > 65535) return null;

        if (secret.length > 170 || secret.includes('AAAAAAAAAAAAAAAAAAAA')) {
            skippedCount++;
            return null;
        }

        return { server, port, secret, original: cleanLink };
    } catch (e) { return null;     }
}

// Scan a whole blob of text (e.g. a pasted Telegram message) and pull out every
// proxy link, even when it is wrapped in other text like
//   "To SeT : Connect Proxy (https://t.me/proxy?server=...&port=...&secret=...)"
// Each match is run through parseLink so validation/skip rules stay identical to
// the one-link-per-line path. Returns an array of parsed proxy objects.
function extractProxiesFromText(text) {
    const found = [];

    // Pass 1 — explicit links. Grab a tg:// or t.me/proxy token, stopping at the
    // first character that can't belong to a link (whitespace, closing paren,
    // quote, angle bracket) so the trailing ")" / emoji / caption is dropped.
    const linkRe = /(?:tg:\/\/|https?:\/\/(?:telegram\.me|t\.me)\/)proxy\?[^\s)"'<>\]]+/gi;
    const linkMatches = text.match(linkRe);
    if (linkMatches) {
        for (const tok of linkMatches) {
            const p = parseLink(tok);
            if (p) found.push(p);
        }
    }

    // Pass 2 — labeled "Server / Port / Secret" blocks with no link, e.g.
    //   🌐sᴇʀᴠᴇʀ › my.host.com
    //   🔌 ᴘᴏʀᴛ › 443
    //   🔓sᴇᴄʀᴇᴛ › ee....
    // Telegram channels dress the labels up with small-capital unicode letters,
    // so normalize those to ASCII first, then match (separator ":" or "›").
    const norm = normalizeSmallCaps(text);
    const labelRe = /server\s*[:›]?\s*([A-Za-z0-9._-]+)[\s\S]*?port\s*[:›]?\s*(\d{1,5})[\s\S]*?secret\s*[:›]?\s*([A-Za-z0-9_+/=-]{8,})/gi;
    let m;
    while ((m = labelRe.exec(norm)) !== null) {
        let server = m[1].replace(/\.+$/, '');           // drop trailing dots
        const port = parseInt(m[2], 10);
        const secret = m[3];
        if (!server || /^unknown$/i.test(server)) continue;
        if (!port || port < 1 || port > 65535) continue;
        if (secret.length > 170 || secret.includes('AAAAAAAAAAAAAAAAAAAA')) { skippedCount++; continue; }
        found.push({ server, port, secret, original: `tg://proxy?server=${server}&port=${port}&secret=${secret}` });
    }

    return found;
}

// Map the small-capital unicode letters channels use to dress up labels
// (sᴇʀᴠᴇʀ ›) back to ASCII, and strip zero-width marks, so the label regex can
// read them. Mirrors the backend labelNormalizer.
const SMALL_CAPS_MAP = {
    'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m',
    'ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ᴛ':'t','ᴜ':'u','ᴠ':'v','ɪ':'i','s':'s'
};
function normalizeSmallCaps(text) {
    let out = '';
    for (const ch of text) {
        if (ch === '​' || ch === '‎' || ch === '‏' || ch === '﻿') continue;
        out += SMALL_CAPS_MAP[ch] || ch;
    }
    return out;
}

function openHelp() {
    const urls = {
        fa: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_FA.md',
        en: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README.md',
        ru: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_RU.md',
        zh: 'https://github.com/rahgozar94725/MTProto-Checker/blob/main/README_ZH.md'
    };
    window.open(urls[currentLang] || urls.en, '_blank', 'noopener');
}

// ----- Telegram authenticated fetch -----

function tgSetStatus(msg, isErr) {
    const el = document.getElementById('tgStatus');
    if (el) {
        el.innerText = msg || '';
        el.style.color = isErr ? 'var(--danger, #ff5c5c)' : '';
    }
}

// Returns the MTProto proxy creds {server, port, secret} from the tg proxy
// link field, or null if missing/invalid.
function tgProxyCreds() {
    const raw = document.getElementById('tgProxyLink').value.trim();
    if (!raw) return null;
    const parsed = parseLink(raw);
    if (!parsed) return null;
    return { server: parsed.server, port: Number(parsed.port), secret: parsed.secret };
}

// On page load, check for a session/credentials already saved on this machine
// and resume from them so the user need not log in again. Reads local files
// only (no network round-trip), so it is instant.
async function tgResumeSession() {
    try {
        const res = await fetch('/tg/me');
        const data = await res.json();
        if (data.has_app_creds) {
            const idEl = document.getElementById('tgAppId');
            const hashEl = document.getElementById('tgAppHash');
            if (idEl && !idEl.value) idEl.value = data.app_id;
            if (hashEl && !hashEl.value) hashEl.value = data.app_hash;
            // Open the advanced section so the restored values are visible.
            const adv = document.querySelector('.tg-adv');
            if (adv) adv.open = true;
        }
        if (data.has_session) {
            tgSetStatus('✅ سشن ذخیره‌شده پیدا شد — وارد هستید. برای دریافت از کانال‌ها نیازی به ورود مجدد نیست.');
            const loginBtn = document.getElementById('tgLoginBtn');
            if (loginBtn) loginBtn.innerText = 'ورود مجدد';
        }
    } catch (e) { /* no saved session; leave the form as-is */ }
}

let tgPollTimer = null;

async function tgPollLoginStatus() {
    try {
        const res = await fetch('/tg/login/status');
        const data = await res.json();
        const codeRow = document.getElementById('tgCodeRow');
        const pwdRow = document.getElementById('tgPwdRow');
        const captchaRow = document.getElementById('tgCaptchaRow');
        codeRow.style.display = data.state === 'awaiting_code' ? '' : 'none';
        pwdRow.style.display = data.state === 'awaiting_password' ? '' : 'none';
        captchaRow.style.display = data.state === 'awaiting_captcha' ? '' : 'none';

        if (data.state === 'awaiting_captcha') {
            tgSetStatus('تأیید امنیتی reCAPTCHA لازم است. لطفاً آن را کامل کنید.');
            tgRenderCaptcha(data.sitekey);
        } else if (data.state === 'awaiting_code') {
            tgSetStatus('کد تایید ارسال شد. کد را وارد کنید.');
        } else if (data.state === 'awaiting_password') {
            tgSetStatus('رمز دو مرحله‌ای (2FA) را وارد کنید.');
        } else if (data.state === 'authorized') {
            tgSetStatus('✅ ورود موفق. اکنون می‌توانید از کانال‌ها دریافت کنید.');
            log('Telegram login successful.');
            clearInterval(tgPollTimer); tgPollTimer = null;
        } else if (data.state === 'failed') {
            tgSetStatus('⛔ ورود ناموفق: ' + (data.error || ''), true);
            log('Telegram login failed: ' + (data.error || ''), true);
            clearInterval(tgPollTimer); tgPollTimer = null;
        }
    } catch (e) { /* keep polling */ }
}

async function tgStartLogin() {
    // Empty proxy → log in over a direct connection; reject only invalid links.
    const proxyRaw = document.getElementById('tgProxyLink').value.trim();
    const creds = tgProxyCreds();
    if (proxyRaw && !creds) return showToast('⚠️ لینک پراکسی MTProto سالم را وارد کنید.', true);
    const phone = document.getElementById('tgPhone').value.trim();
    if (!phone) return showToast('⚠️ شماره تلفن را وارد کنید.', true);

    const body = { proxy: creds || {}, phone };
    const appId = document.getElementById('tgAppId').value.trim();
    const appHash = document.getElementById('tgAppHash').value.trim();
    if (appId && appHash) { body.app_id = Number(appId); body.app_hash = appHash; }

    // Reset any captcha widget from a previous attempt so it re-renders fresh.
    tgCaptchaSitekey = null;
    document.getElementById('tgCaptchaRow').style.display = 'none';

    tgSetStatus('در حال اتصال و ارسال کد...');
    try {
        const res = await fetch('/tg/login/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.error) { tgSetStatus('⛔ ' + data.error, true); return; }
        if (tgPollTimer) clearInterval(tgPollTimer);
        tgPollTimer = setInterval(tgPollLoginStatus, 1500);
        tgPollLoginStatus();
    } catch (e) {
        tgSetStatus('⛔ ' + e.message, true);
    }
}

async function tgSubmitCode() {
    const code = document.getElementById('tgCode').value.trim();
    if (!code) return;
    try {
        const res = await fetch('/tg/login/code', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (data.error) { tgSetStatus('⛔ ' + data.error, true); return; }
        tgSetStatus('در حال بررسی کد...');
    } catch (e) { tgSetStatus('⛔ ' + e.message, true); }
}

async function tgSubmitPassword() {
    const password = document.getElementById('tgPwd').value;
    try {
        const res = await fetch('/tg/login/password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.error) { tgSetStatus('⛔ ' + data.error, true); return; }
        tgSetStatus('در حال بررسی رمز...');
    } catch (e) { tgSetStatus('⛔ ' + e.message, true); }
}

// ---- Telegram login reCAPTCHA handling ----
let tgCaptchaWidgetId = null;
let tgCaptchaSitekey = null;
let tgRecaptchaLoading = false;

// Loads Google's reCAPTCHA script on demand and resolves once grecaptcha.render
// is available.
function tgLoadRecaptcha() {
    return new Promise((resolve, reject) => {
        if (window.grecaptcha && window.grecaptcha.render) return resolve();
        const waitReady = () => {
            const iv = setInterval(() => {
                if (window.grecaptcha && window.grecaptcha.render) { clearInterval(iv); resolve(); }
            }, 100);
            setTimeout(() => { clearInterval(iv); if (!(window.grecaptcha && window.grecaptcha.render)) reject(new Error('reCAPTCHA load timeout')); }, 15000);
        };
        if (tgRecaptchaLoading) return waitReady();
        tgRecaptchaLoading = true;
        const s = document.createElement('script');
        s.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
        s.async = true; s.defer = true;
        s.onload = waitReady;
        s.onerror = () => reject(new Error('failed to load reCAPTCHA script'));
        document.head.appendChild(s);
    });
}

// Renders the reCAPTCHA widget for the given Telegram site key. On solve, the
// token is posted back to the server which retries send-code with it.
async function tgRenderCaptcha(sitekey) {
    if (!sitekey || tgCaptchaSitekey === sitekey) return; // already rendered for this key
    try {
        await tgLoadRecaptcha();
    } catch (e) {
        tgSetStatus('⛔ بارگذاری reCAPTCHA ناموفق بود (احتمالاً دسترسی به گوگل مسدود است). با VPN/پراکسی روی مرورگر دوباره تلاش کنید.', true);
        return;
    }
    const container = document.getElementById('tgCaptcha');
    container.innerHTML = '';
    try {
        tgCaptchaWidgetId = window.grecaptcha.render(container, {
            sitekey: sitekey,
            callback: tgSubmitCaptcha
        });
        tgCaptchaSitekey = sitekey;
    } catch (e) {
        tgSetStatus('⛔ نمایش reCAPTCHA ناموفق بود: ' + e.message, true);
    }
}

async function tgSubmitCaptcha(token) {
    if (!token) return;
    tgSetStatus('در حال ارسال تأیید امنیتی...');
    try {
        const res = await fetch('/tg/login/captcha', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (data.error) { tgSetStatus('⛔ ' + data.error, true); return; }
        tgSetStatus('تأیید امنیتی ارسال شد. در حال ارسال کد...');
    } catch (e) { tgSetStatus('⛔ ' + e.message, true); }
}

async function tgLogout() {
    try {
        await fetch('/tg/logout', { method: 'POST' });
        tgSetStatus('از حساب خارج شدید. session حذف شد.');
        const loginBtn = document.getElementById('tgLoginBtn');
        if (loginBtn) loginBtn.innerText = 'ورود';
        log('Telegram session removed.');
    } catch (e) { tgSetStatus('⛔ ' + e.message, true); }
}

async function fetchViaTelegram() {
    const t = translations[currentLang];
    // An empty proxy field is allowed: the backend then connects to Telegram
    // directly (for users with unfiltered access). Only a *non-empty but
    // invalid* link is rejected.
    const proxyRaw = document.getElementById('tgProxyLink').value.trim();
    const creds = tgProxyCreds();
    if (proxyRaw && !creds) return showToast('⚠️ لینک پراکسی MTProto سالم را وارد کنید.', true);

    const chEl = document.getElementById('inputChannels');
    const channels = dedupeChannels(chEl.value);
    if (channels.length === 0) return showToast(t.toastNoChannels, true);
    // Write the de-duplicated list back and persist it for next time.
    chEl.value = channels.join('\n');
    saveChannels();

    // Remember the MTProto proxy link so it survives reloads.
    localStorage.setItem('fetchProxy', document.getElementById('tgProxyLink').value.trim());

    // How many (newest) proxies to take from each channel; 0 = all.
    let perChannel = parseInt(document.getElementById('tgPerChannel').value, 10);
    if (isNaN(perChannel) || perChannel < 0) perChannel = 0;
    if (perChannel > 1000) perChannel = 1000;
    localStorage.setItem('tgPerChannel', perChannel);

    const btn = document.getElementById('fetchBtn');
    btn.disabled = true;
    btn.innerText = t.fetchingBtn;
    tgSetStatus('در حال دریافت از طریق تلگرام...');
    setFetchProgress(0, 'اتصال به تلگرام...');
    log(`Fetching ${perChannel === 0 ? 'all' : 'up to ' + perChannel} newest proxies from ${channels.length} channel(s) via Telegram...`);

    try {
        const res = await fetch('/fetch-channels-tg', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channels, proxy: creds || {}, limit: perChannel })
        });
        if (!res.ok || !res.body) throw new Error('Server error');

        // Consume the SSE stream: 'progress' events drive the percentage bar,
        // the final 'done' event carries the full result payload.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let data = null;
        outer:
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n');
            buffer = frames.pop();
            for (const frame of frames) {
                if (!frame.trim()) continue;
                let eventType = '', dataStr = '';
                for (const line of frame.split('\n')) {
                    if (line.startsWith('event: ')) eventType = line.slice(7);
                    else if (line.startsWith('data: ')) dataStr = line.slice(6);
                }
                if (!dataStr) continue;
                const payload = JSON.parse(dataStr);
                if (eventType === 'progress') {
                    const pct = payload.total > 0 ? Math.round((payload.done / payload.total) * 100) : 0;
                    setFetchProgress(pct, `${pct}% — ${payload.note || ''}`);
                } else if (eventType === 'done') {
                    data = payload;
                    break outer;
                }
            }
        }
        if (!data) throw new Error('اتصال قطع شد');
        setFetchProgress(100, '۱۰۰٪');
        const links = data.links || [];

        if (data.notes && data.notes.length) {
            data.notes.forEach(n => log(`📊 ${n}`));
        }
        if (data.errors && data.errors.length) {
            data.errors.forEach(e => log(`TG channel error: ${e}`, true));
        }
        if (links.length === 0) {
            showToast(t.toastFetchNone, true);
            tgSetStatus('چیزی دریافت نشد.' + (data.errors && data.errors.length ? ' ' + data.errors[0] : ''), true);
            return;
        }

        const input = document.getElementById('inputProxies');
        const existing = input.value.split('\n').map(s => s.trim()).filter(Boolean);
        const seen = new Set(existing);
        const added = [];
        for (const l of links) {
            if (!seen.has(l)) { seen.add(l); added.push(l); }
        }
        input.value = existing.concat(added).join('\n');
        log(`Fetched ${links.length} proxies (${added.length} new) via Telegram.`);
        showToast(t.toastFetched.replace('{n}', added.length));
        tgSetStatus(`✅ ${added.length} پراکسی جدید دریافت شد.`);
    } catch (e) {
        log(`TG FETCH ERROR: ${e.message}`, true);
        showToast(t.toastFetchError, true);
        tgSetStatus('⛔ ' + e.message, true);
    } finally {
        btn.disabled = false;
        btn.innerText = t.fetchBtn;
        // Leave the completed bar visible briefly, then hide it.
        setTimeout(hideFetchProgress, 1500);
    }
}

// Drive the channel-fetch progress bar (0-100). Shows the box on first call.
function setFetchProgress(pct, label) {
    const box = document.getElementById('tgProgressBox');
    const bar = document.getElementById('tgProgressBar');
    const lbl = document.getElementById('tgProgressLabel');
    if (!box || !bar) return;
    box.style.display = 'block';
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (lbl) lbl.innerText = label || '';
}

function hideFetchProgress() {
    const box = document.getElementById('tgProgressBox');
    if (box) box.style.display = 'none';
}

function handleStartStop() {
    if (scanState === 'idle') startCheck();
    else stopScan();
}

function stopScan() {
    if (currentController) {
        currentController.abort();
        currentController = null;
    }
    scanState = 'idle';
    updateStartBtn();
    document.getElementById('pauseBtn').style.display = 'none';
    isPaused = false;
    log('STOPPED');
}

function togglePause() {
    isPaused = !isPaused;
    if (isPaused) {
        if (currentController) {
            currentController.abort();
            currentController = null;
        }
        updatePauseBtn();
        log('PAUSED');
    } else {
        updatePauseBtn();
        log('RESUMED');
        const remaining = allProxies.filter(p => !checkedKeys.has(`${p.server}:${p.port}:${p.secret}`));
        if (remaining.length === 0) {
            finish();
            return;
        }
        log(`Resuming with ${remaining.length} unchecked...`);
        runCheckStream(remaining, globalLinkMap).then(r => {
            if (r === 'done' || r === 'timeout') finish();
        });
    }
}

async function runCheckStream(proxies, linkMap) {
    if (proxies.length === 0) return 'done';

    const controller = new AbortController();
    currentController = controller;
    const baseline = checkedKeys.size;
    const totalOrig = allProxies.length;
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
        let buffer = '';

        while (!scanDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const frames = buffer.split('\n\n');
            buffer = frames.pop();

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
                    const currentTotal = baseline + data.completed;
                    updateUI(currentTotal, totalOrig);

                    const key = `${data.server}:${data.port}:${data.secret}`;
                    checkedKeys.add(key);

                    if (data.ok) {
                        const orig = linkMap.get(key) || `tg://proxy?server=${data.server}&port=${data.port}&secret=${data.secret}`;
                        workingProxies.push({ link: orig, ping: data.ping });
                        log(`SUCCESS: ${data.server} (${data.ping}ms)`);
                        updateOutput();
                    }
                }
            }
        }

        return 'done';
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            return isPaused ? 'paused' : 'timeout';
        }
        throw err;
    }
}

async function startCheck() {
    try {
        const t = translations[currentLang];
        const input = document.getElementById('inputProxies').value;
        
        if (!input) return showToast(t.toastEmpty, true);

        isPaused = false;
        currentController = null;
        checkedKeys = new Set();
        allProxies = [];

        skippedCount = 0;
        // Two complementary passes so we accept both clean one-per-line lists
        // AND raw pasted text where links are buried inside other content:
        //  1) per-line parseLink (handles plain links, even non-t.me hosts),
        //  2) a whole-text scan that digs proxy links out of surrounding text.
        // Dedupe below collapses any overlap.
        let validLinks = input.split('\n').map(parseLink).filter(l => l !== null);
        validLinks = validLinks.concat(extractProxiesFromText(input));

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

        log(`Parsed ${validLinks.length} valid links.` + (skippedCount > 0
            ? ` Skipped ${skippedCount} decoy/invalid proxies (padded or over-long secrets — they never connect).`
            : ''));

        workingProxies = [];
        document.getElementById('outputProxies').value = '';

        const total = validLinks.length;

        log(`Settings: concurrency=${getConcurrency()}, timeout=${getTimeout()}s`);

        scanState = 'scanning';
        updateStartBtn();
        const pauseBtn = document.getElementById('pauseBtn');
        updatePauseBtn();
        pauseBtn.style.display = '';
        updateUI(0, total);

        // Build lookup: "server:port:secret" → original link
        globalLinkMap = new Map();
        for (const p of validLinks) {
            globalLinkMap.set(`${p.server}:${p.port}:${p.secret}`, p.original);
        }

        allProxies = validLinks;

        const result = await runCheckStream(allProxies, globalLinkMap);
        if (result === 'done' || result === 'timeout') {
            if (result === 'timeout') {
                updateUI(allProxies.length, allProxies.length);
            }
            finish();
        }
        // result === 'paused' → togglePause handles resume
    } catch (e) {
        log(`MAIN ERROR: ${e.message}`, true);
        alert(translations[currentLang].errorGeneric);
        scanState = 'idle';
        updateStartBtn();
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
    const pauseBtn = document.getElementById('pauseBtn');
    scanState = 'idle';
    updateStartBtn();
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

// Resume any saved Telegram session/credentials on startup.
tgResumeSession();

const soundCheck = document.getElementById('soundCheck');
if (soundCheck) {
    if (localStorage.getItem('soundEnabled') === 'true') soundCheck.checked = true;
    syncSoundUI();
    soundCheck.addEventListener('change', () => {
        localStorage.setItem('soundEnabled', soundCheck.checked);
        syncSoundUI();
    });
}
