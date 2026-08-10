// Builds the proxy-source snapshot: fetch the public source lists, parse them with the
// frontend's own parser, dedupe by server:port:secret, record which sources carried each
// proxy, and write one line per proxy in the grammar below.
//
//   # generated <ISO8601> by scripts/build-snapshot.mjs
//   # 0 <short url of source 0>
//   …
//   tg://proxy?server=…&port=443&secret=…#seen=1;src=8
//
// Two rules are load-bearing:
//
//   1. There is NO space before the `#`. `new URL().search` ends at `#`, so a space would
//      land inside the last parameter value and every line would yield a secret with a
//      trailing space — a different proxyKey, and a secret the server only rescues through
//      decodeSecret's junk-trim path.
//   2. A source-side comment fragment (`…secret=ee00# MTProto EU`) is stripped before the
//      line is parsed, not after. Stripping afterwards would leave the collected key holding
//      the padded secret while the emitted line holds the bare one.
//
// The parser is imported from public/js/parse.js and never reimplemented: main_test.go
// already carries a duplicate Go parser that CLAUDE.md flags as drift-prone.

import { writeFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseLink, proxyKey } from '../public/js/parse.js';
import { DEFAULT_SOURCES, RAW_PREFIX } from '../public/js/sources.js';

// Source ids are positional: index 3 there is `src=3` in every line of the snapshot, so
// appending is safe and reordering is not. Phase 0 measured this exact order. The list lives
// in public/js/sources.js because the UI's source model needs the same 17 defaults, and two
// copies that drifted apart would misattribute every line of the snapshot.
export const SOURCES = DEFAULT_SOURCES;

const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT = 'snapshot.txt';

export function shortUrl(url) {
    return url.startsWith(RAW_PREFIX) ? url.slice(RAW_PREFIX.length) : url;
}

// Everything from the first `#` is a source-side comment, not part of the link.
function stripFragment(line) {
    const hash = line.indexOf('#');
    return (hash === -1 ? line : line.slice(0, hash)).trimEnd();
}

export function formatLine(link, srcs) {
    return `${link}#seen=${srcs.length};src=${srcs.join(',')}`;
}

// → { universe: Map<key, {link, srcs}>, perSource: [{index, unique, duplicates, spam}] }
export function collect(texts) {
    const universe = new Map();
    const perSource = [];

    texts.forEach((text, index) => {
        const seenHere = new Set();
        let duplicates = 0;
        let spam = 0;

        for (const line of text.split('\n')) {
            const result = parseLink(stripFragment(line));
            if (!result.ok) {
                if (result.reason === 'spam') spam++;
                continue;
            }

            const key = proxyKey(result.proxy);
            if (seenHere.has(key)) {
                duplicates++;
                continue;
            }
            seenHere.add(key);

            const entry = universe.get(key);
            if (entry) entry.srcs.push(index);
            else universe.set(key, { link: result.proxy.original, srcs: [index] });
        }

        perSource.push({ index, unique: seenHere.size, duplicates, spam });
    });

    return { universe, perSource };
}

// Descending `seen`, tie-broken ascending by key. File order is scan order on the server,
// so the proxies most likely to work come first; the tie-break keeps the nightly diff
// readable.
//
// The direction is measured, and it has been measured both ways. Phase 0 (2026-08-09) found
// redundancy anti-predicting liveness and this sort was ascending because of it. The
// 2026-08-10 re-scan did not reproduce that: two warm runs over the same 784-proxy universe
// both show a monotonic gradient the other way — `seen<=2` at 15–24 % working, `seen>=5` at
// 81–100 %. The deciding variable turned out to be session warmth, not the data: the Phase 0
// regime was a cold `sharedSession`, which in the same slot also produced a 1/785 outlier
// against 303/785 warm on identical input. Re-measure with both arms in one warm session
// before flipping this back.
export function snapshotLines(universe) {
    return [...universe.entries()]
        .sort((a, b) => b[1].srcs.length - a[1].srcs.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, entry]) => formatLine(entry.link, entry.srcs));
}

// → { text, universe, perSource }. Throws if a source carried no parseable link at all:
// a source that has gone to a 404 page or changed format silently is a build failure, not
// a smaller snapshot.
export function buildSnapshot({ urls, texts, generatedAt }) {
    const { universe, perSource } = collect(texts);

    const empty = perSource.filter(s => s.unique === 0);
    if (empty.length > 0) {
        throw new Error(`no parseable link from: ${empty.map(s => `${s.index} ${shortUrl(urls[s.index])}`).join(', ')}`);
    }

    const header = [
        `# generated ${generatedAt} by scripts/build-snapshot.mjs`,
        ...urls.map((url, index) => `# ${index} ${shortUrl(url)}`),
    ];

    return { text: [...header, ...snapshotLines(universe)].join('\n') + '\n', universe, perSource };
}

// Fetches every source concurrently. Rejects on the first non-200 or unreachable source —
// the snapshot is all-or-nothing on purpose.
export async function fetchAll(urls, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    return Promise.all(urls.map(async url => {
        let res;
        try {
            res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new Error(`${shortUrl(url)}: ${err.message || err}`);
        }
        if (!res.ok) throw new Error(`${shortUrl(url)}: HTTP ${res.status}`);
        return res.text();
    }));
}

async function main(output) {
    const texts = await fetchAll(SOURCES);
    const { text, universe, perSource } = buildSnapshot({
        urls: SOURCES,
        texts,
        generatedAt: new Date().toISOString(),
    });

    writeFileSync(output, text);

    for (const s of perSource) {
        stdout.write(`${String(s.index).padStart(2)} ${String(s.unique).padStart(6)} unique  ${shortUrl(SOURCES[s.index])}\n`);
    }
    stdout.write(`\n${universe.size} unique proxies, ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MiB -> ${output}\n`);
}

// Run only when invoked directly, so the test can import the module without fetching.
// import.meta.main is Node 24.2+; CI runs Node 22.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
    try {
        await main(argv[2] || DEFAULT_OUTPUT);
    } catch (err) {
        stderr.write(`build-snapshot: ${err.message || err}\n`);
        exit(1);
    }
}
