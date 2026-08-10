// Owns the source list: the baked defaults, the shape of a source entry, and the
// (de)serialization of the list that app.js persists in localStorage. Pure by the same
// contract parse.js holds: no DOM, no fetch, no module-level mutable state. app.js owns the
// wiring and the storage keys; nothing here reads localStorage itself.
//
// A source is `{ url, enabled, addedByUser }`, plus `{ score }` once a scan has credited it,
// and the model is keyed by **url** everywhere. The nightly rebuild is free to append or
// reorder sources, so an index-keyed model would silently repoint a score.
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

import { proxyKey } from './parse.js';

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

// How a snapshot header names a source: `# 0 iwh3n/tg-proxy/…`. It lives here rather than in
// scripts/build-snapshot.mjs (which imports it) because recordScan joins a header back onto
// this model and both sides have to shorten a URL the same way.
export function shortUrl(url) {
    return url.startsWith(RAW_PREFIX) ? url.slice(RAW_PREFIX.length) : url;
}

// The restore-defaults action, and the fallback every unusable stored value lands on. A
// fresh array of fresh entries each call, so a caller mutating one cannot poison the next.
// Scores go with it: restoring the defaults is a reset, not a re-enable.
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
        seen.set(entry.url, { enabled: entry.enabled !== false, score: readScore(entry.score) });
    }

    const builtIn = defaultSources().map(source => withStored(source, seen.get(source.url)));
    const added = [...seen]
        .filter(([url]) => !DEFAULT_SOURCES.includes(url))
        .map(([url, storedEntry]) =>
            withStored({ url, enabled: true, addedByUser: true }, storedEntry));

    return [...builtIn, ...added];
}

// A stored score is as foreign as the rest of the value, and it is arithmetic the UI divides
// by — so anything that is not a pair of finite non-negative counts and a string date is
// dropped, leaving the source unscored rather than displaying NaN or throwing.
function readScore(value) {
    if (!value || typeof value !== 'object') return null;

    const { linksProvided, linksWorking, lastScan } = value;
    if (!Number.isFinite(linksProvided) || !Number.isFinite(linksWorking)) return null;
    if (linksProvided < 0 || linksWorking < 0) return null;
    if (typeof lastScan !== 'string') return null;

    return { linksProvided, linksWorking, lastScan };
}

// `score` stays absent until a scan credits the source, so an untouched entry is deep-equal to
// the default it came from.
function withStored(source, storedEntry) {
    if (!storedEntry) return source;

    const merged = { ...source, enabled: storedEntry.enabled };
    if (storedEntry.score) merged.score = storedEntry.score;

    return merged;
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
// score attached to a row the user can turn back on.
export function removeSource(sources, url) {
    return sources.filter(source => source.url !== url || !source.addedByUser);
}

// → the list with `{ linksProvided, linksWorking, lastScan }` added to every source that
// published at least one scanned link, accumulating over whatever score it already carried.
//
// `sourceUrls` is a snapshot header (index → url, short or full) and `provided`/`working` are
// the `srcs` id arrays parseSnapshot() attached to the scanned and the working links. Every
// source of a working proxy is credited, not just the first: a proxy that five lists carry
// says something about all five, and crediting only `srcs[0]` would make the score a function
// of DEFAULT_SOURCES order rather than of quality.
//
// A source that published nothing this scan is returned untouched — not credited, and not
// penalized either, since a disabled or unreachable list saying nothing is not evidence
// against it.
export function recordScan(sources, { sourceUrls = [], provided = [], working = [], scannedAt = '' } = {}) {
    const providedCounts = tally(provided, sourceUrls);
    const workingCounts = tally(working, sourceUrls);

    return sources.map(source => {
        const key = shortUrl(source.url);
        const links = providedCounts.get(key) || 0;
        if (links === 0) return source;

        const score = source.score || { linksProvided: 0, linksWorking: 0 };

        return {
            ...source,
            score: {
                linksProvided: score.linksProvided + links,
                linksWorking: score.linksWorking + (workingCounts.get(key) || 0),
                lastScan: scannedAt,
            },
        };
    });
}

// → one working rate per `src=` id, i.e. indexed the way the snapshot header is. A source the
// user disabled rates 0 rather than being left out, so a disabled list stops pulling proxies
// up the scan order without changing what the ids mean.
//
// Zero is also what an unscored source, an unknown header slot and a stored score claiming
// zero published links all rate — the last one is why the division is guarded rather than
// trusted: readScore() accepts `linksProvided: 0` as a well-formed foreign value.
export function rateBySourceId(sources, sourceUrls = []) {
    const byKey = new Map();
    for (const source of sources) {
        if (!source.enabled) continue;
        if (!source.score || source.score.linksProvided === 0) continue;
        byKey.set(shortUrl(source.url), source.score.linksWorking / source.score.linksProvided);
    }

    return sourceUrls.map(url => byKey.get(shortUrl(url)) || 0);
}

// → the proxies reordered for scanning: most-redundant first, then best-scoring source first.
// File order is scan order on the server (`/check-stream` walks the request body in order), so
// this is what decides which proxies a user watching the first rows actually sees.
//
// Both keys point the same way and both were measured: redundancy predicts life (`seen>=5` at
// 81–100 % against `seen<=2` at 15–24 %, reproduced twice — see tasks/plan.md Phase 0b), and a
// source's own hit rate is the user's local re-derivation of the same ranking. A proxy is
// ranked by its *best* source, matching recordScan's credit-every-source rule; ranking by
// `srcs[0]` would make the order a function of DEFAULT_SOURCES order instead.
//
// Anything the snapshot never mentioned ranks 0 on both keys and lands at the end in paste
// order — Array.prototype.sort is stable, so a pasted list with no attribution at all comes
// back exactly as it went in.
export function orderForScan(proxies, { attribution = new Map(), rates = [] } = {}) {
    return proxies
        .map(proxy => ({ proxy, meta: attribution.get(proxyKey(proxy)) }))
        .sort((a, b) => seenOf(b.meta) - seenOf(a.meta) || bestRate(b.meta, rates) - bestRate(a.meta, rates))
        .map(entry => entry.proxy);
}

function seenOf(meta) {
    return meta ? meta.seen : 0;
}

function bestRate(meta, rates) {
    if (!meta) return 0;

    let best = 0;
    for (const id of meta.srcs) {
        const rate = rates[id] || 0;
        if (rate > best) best = rate;
    }

    return best;
}

// One tally entry per (link, source) pair, keyed the way the header names the source. The Set
// is why a line that repeats an id credits it once; the string check is why an id no header
// line declared is dropped rather than counted under `undefined`.
function tally(rows, sourceUrls) {
    const counts = new Map();

    for (const srcs of rows) {
        if (!Array.isArray(srcs)) continue;
        for (const id of new Set(srcs)) {
            const url = sourceUrls[id];
            if (typeof url !== 'string') continue;

            const key = shortUrl(url);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    return counts;
}
