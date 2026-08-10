// Owns the source list: the baked defaults, the shape of a source entry, and the
// (de)serialization of the list that app.js persists in localStorage. Pure by the same
// contract parse.js holds: no DOM, no fetch, no module-level mutable state. app.js owns the
// wiring and the storage keys; nothing here reads localStorage itself.
//
// A source is `{ url, enabled, addedByUser }` and the model is keyed by **url** everywhere.
// Task 9 hangs per-source scores off these entries and the nightly rebuild is free to append
// or reorder sources, so an index-keyed model would silently repoint a score.
//
// scripts/build-snapshot.mjs imports DEFAULT_SOURCES from here rather than keeping its own
// copy: `src=` ids in the snapshot are positions in this array, so two lists that drifted
// apart would misattribute every line. Appending is safe, reordering is not.
//
// parseSources is total. Its input is a localStorage value, which is origin-keyed on
// 127.0.0.1:3000 and can therefore have been written by any other local dev server — the
// same reasoning that makes resolveLang() total in app.js. Anything unrecognisable resolves
// to the defaults rather than throwing, because the throw would abort module evaluation and
// take the whole page's event wiring with it.

export const RAW_PREFIX = 'https://raw.githubusercontent.com/';

export const DEFAULT_SOURCES = [
    `${RAW_PREFIX}iwh3n/tg-proxy/refs/heads/main/proxys/All_Proxys.txt`,
    `${RAW_PREFIX}Argh94/Proxy-List/main/MTProto.txt`,
    `${RAW_PREFIX}Kira00011/MTProto/main/all_proxies.txt`,
    `${RAW_PREFIX}SoliSpirit/mtproto/master/all_proxies.txt`,
    `${RAW_PREFIX}Therealwh/MTPproxyLIST/refs/heads/main/verified/proxy_all_verified.txt`,
    `${RAW_PREFIX}kort0881/telegram-proxy-collector/main/proxy_all.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no1.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no2.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no3.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no4.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no5.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no6.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no7.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no8.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no9.txt`,
    `${RAW_PREFIX}V2RAYCONFIGSPOOL/TELEGRAM_PROXY_SUB/main/telegram_proxy_no10.txt`,
    `${RAW_PREFIX}FLAT447/v2ray-lists/refs/heads/main/blacklist.txt`,
];

// The restore-defaults action, and the fallback every unusable stored value lands on. A
// fresh array of fresh entries each call, so a caller mutating one cannot poison the next.
export function defaultSources() {
    return DEFAULT_SOURCES.map(url => ({ url, enabled: true, addedByUser: false }));
}

export function serializeSources(sources) {
    return JSON.stringify(sources);
}

// → the stored list merged over the defaults: every built-in present in DEFAULT_SOURCES
// order carrying its stored `enabled` flag, then the user-added ones in stored order. A
// built-in the stored value never mentions comes back enabled, which is how a source added
// to DEFAULT_SOURCES after a user's list was written reaches them at all.
export function parseSources(stored) {
    let entries;
    try {
        entries = JSON.parse(stored);
    } catch {
        return defaultSources();
    }
    if (!Array.isArray(entries)) return defaultSources();

    const seen = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry.url !== 'string') continue;
        if (seen.has(entry.url)) continue;
        seen.set(entry.url, entry.enabled !== false);
    }

    const builtIn = defaultSources().map(source => ({
        ...source,
        enabled: seen.has(source.url) ? seen.get(source.url) : true,
    }));
    const added = [...seen]
        .filter(([url]) => !DEFAULT_SOURCES.includes(url))
        .map(([url, enabled]) => ({ url, enabled, addedByUser: true }));

    return [...builtIn, ...added];
}

export function setEnabled(sources, url, enabled) {
    return sources.map(source => (source.url === url ? { ...source, enabled } : source));
}

// Ignores a duplicate and a blank rather than reporting them: the caller is a text field and
// both are ordinary typing, not errors worth a toast.
export function addSource(sources, url) {
    const trimmed = url.trim();
    if (!trimmed || sources.some(source => source.url === trimmed)) return sources;

    return [...sources, { url: trimmed, enabled: true, addedByUser: true }];
}

// Built-ins are not removable — disabling one is how it stops being scanned, which keeps its
// Task 9 score attached to a row the user can turn back on.
export function removeSource(sources, url) {
    return sources.filter(source => source.url !== url || !source.addedByUser);
}
