// Link parsing for pasted proxy lists. Pure by contract: no module-level mutable state,
// no DOM, no logging — callers decide what to do with the counts. The rules below are the
// ones the classic script shipped with, quirks included; `tests/unit/parse.test.js`
// replays a golden baseline recorded before the ES-module refactor to prove that.

const SPAM_SECRET_RUN = 'AAAAAAAAAAAAAAAAAAAA';
const MAX_SECRET_LEN = 170;

export const ACCEPTED_EXTENSIONS = ['.txt', '.csv', '.list'];

// The dedupe identity of a proxy, and the key of the scan-time lookup maps in app.js.
export function proxyKey(p) {
    return `${p.server}:${p.port}:${p.secret}`;
}

export function isAcceptedFilename(name) {
    const lower = name.toLowerCase();
    return ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// → { ok: true, proxy: { server, port, secret, original } }
// → { ok: false, reason: 'no-scheme' | 'malformed' | 'bad-port' | 'spam' }
export function parseLink(link) {
    // A stray '.' before '&' is the single most common hand-editing typo in shared lists.
    // String.replace with a string pattern only fixes the first one — kept as-is.
    const cleanLink = link.trim().replace('.&', '&');
    if (!cleanLink.includes('://')) return { ok: false, reason: 'no-scheme' };

    let params;
    try {
        params = new URLSearchParams(new URL(cleanLink).search);
    } catch {
        return { ok: false, reason: 'malformed' };
    }

    const server = params.get('server');
    const secret = params.get('secret');
    // No radix, matching the original: '443abc' reads as 443 and '0x1bb' as hexadecimal.
    const port = parseInt(params.get('port'));

    // NaN and 0 are both falsy, so a non-numeric or zero port lands here, not in bad-port.
    if (!server || !port || !secret) return { ok: false, reason: 'malformed' };
    if (port <= 0 || port > 65535) return { ok: false, reason: 'bad-port' };

    // Public spam lists pad secrets with a long AAAA… run; those hosts never answer.
    // This check runs after the port check, so an out-of-range spam link is bad-port.
    if (secret.length > MAX_SECRET_LEN || secret.includes(SPAM_SECRET_RUN)) {
        return { ok: false, reason: 'spam' };
    }

    return { ok: true, proxy: { server, port, secret, original: cleanLink } };
}

// → { proxies, skipped, duplicates }
// `skipped` counts spam secrets only — a merely malformed line is dropped silently,
// which is what the #tileSkipped number has always meant.
export function parseProxyList(text) {
    const proxies = [];
    const seen = new Set();
    let skipped = 0;
    let duplicates = 0;

    for (const line of text.split('\n')) {
        const result = parseLink(line);
        if (!result.ok) {
            if (result.reason === 'spam') skipped++;
            continue;
        }

        const key = proxyKey(result.proxy);
        if (seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        proxies.push(result.proxy);
    }

    return { proxies, skipped, duplicates };
}
