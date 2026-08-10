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

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseLink, proxyKey } from '../public/js/parse.js';
import { splitFragment } from '../public/js/snapshot.js';
import { DEFAULT_SOURCES, shortUrl } from '../public/js/sources.js';

// Source ids are positional: index 3 there is `src=3` in every line of the snapshot, so
// appending is safe and reordering is not. Phase 0 measured this exact order. The list lives
// in public/js/sources.js because the UI's source model needs the same 17 defaults, and two
// copies that drifted apart would misattribute every line of the snapshot.
export const SOURCES = DEFAULT_SOURCES;

const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT = 'snapshot.txt';

// Re-exported rather than defined here: the UI's scoring joins a snapshot header back onto the
// source model, so both sides have to shorten a URL the same way.
export { shortUrl };

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
            // Everything from the first `#` is a source-side comment, not part of the link. The
            // rule lives in snapshot.js because the reader has to apply it identically.
            const result = parseLink(splitFragment(line).link);
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

// The volume drift guard. The 17 sources are third-party repositories fetched by mutable
// branch ref, and this snapshot is embedded into every release binary and loaded into the
// user's textarea by one click — so a takeover of any one of them is a position to put
// attacker-operated proxies in front of every user, and "it parsed" is not evidence of
// anything. Pinning each source to a commit SHA would close that properly and is what the
// audit asked for first; it is also unavailable here, because these files are rewritten
// daily and pinning them freezes the freshness the nightly rebuild exists to deliver.
//
// So the build fails closed on volume instead: a source that suddenly carries twice what it
// used to has to be looked at by a human before it ships. The bands are deliberately loose —
// this is a tripwire for a list being flooded, not a linter for daily variation.
//
// Known residual, and it is not small: a source whose contents are *replaced* rather than
// appended to keeps its count and passes. Catching that needs a churn comparison against the
// previous snapshot, which is a separate change.
// The slack term is on the high side only, and that asymmetry is the point. Subtracted on the
// low side it erased the band for every source too small to absorb it: ten of the seventeen
// defaults carry 14–15 links, `ceil((14 - 20) / 2)` is -3, and `unique < low` can never be
// true — so those ten had no lower bound at all and their only floor was the empty-source
// check below. That is the cheap half of the attack this guard exists to catch: set each of
// them to one attacker line and every gate stays green. Halving is the floor now, never below
// 1, which costs a red run on a genuinely bad day at a small source — which is a human
// looking at it, i.e. the guard working.
const DRIFT_FACTOR = 2;
const DRIFT_SLACK = 20;

export function driftBand(baseline) {
    return {
        low: Math.max(1, Math.ceil(baseline / DRIFT_FACTOR)),
        high: baseline * DRIFT_FACTOR + DRIFT_SLACK,
    };
}

// Throws when the observed counts have moved past the band, when the source list has changed
// length, or when a source has moved position — the last one because `src=` ids are positions
// in DEFAULT_SOURCES, so a reorder silently re-attributes every line of every past snapshot
// and the baseline is the only file that would notice.
export function checkDrift(urls, perSource, baseline) {
    const rows = baseline?.sources;
    if (!Array.isArray(rows) || rows.length !== urls.length) {
        throw new Error(
            `baseline covers ${Array.isArray(rows) ? rows.length : 'no'} sources, DEFAULT_SOURCES has ${urls.length}` +
            ' — rebuild it with --write-baseline after reviewing the change'
        );
    }

    const problems = [];
    for (const s of perSource) {
        const row = rows[s.index];
        const short = shortUrl(urls[s.index]);
        if (row.url !== short) {
            problems.push(`${s.index}: baseline holds ${row.url}, DEFAULT_SOURCES holds ${short} — sources were reordered or replaced`);
            continue;
        }
        const { low, high } = driftBand(row.unique);
        if (s.unique > high) {
            problems.push(`${s.index} ${short}: ${s.unique} links, baseline ${row.unique} (max ${high}) — flooded?`);
        } else if (s.unique < low) {
            problems.push(`${s.index} ${short}: ${s.unique} links, baseline ${row.unique} (min ${low}) — gutted or reformatted?`);
        }
    }
    if (problems.length > 0) {
        throw new Error(`source volume drift:\n  ${problems.join('\n  ')}`);
    }
}

// The counts observed by this run, in the file's own shape.
export function baselineFrom(urls, perSource, generatedAt) {
    return {
        note: 'Per-source link counts the drift guard in build-snapshot.mjs compares against. Bump deliberately, never automatically.',
        generatedAt,
        sources: perSource.map(s => ({ src: s.index, url: shortUrl(urls[s.index]), unique: s.unique })),
    };
}

// → { text, universe, perSource }. Throws if a source carried no parseable link at all —
// a source that has gone to a 404 page or changed format silently is a build failure, not
// a smaller snapshot — and, when a baseline is supplied, if any source's volume has drifted
// past its band.
export function buildSnapshot({ urls, texts, generatedAt, baseline }) {
    const { universe, perSource } = collect(texts);

    const empty = perSource.filter(s => s.unique === 0);
    if (empty.length > 0) {
        throw new Error(`no parseable link from: ${empty.map(s => `${s.index} ${shortUrl(urls[s.index])}`).join(', ')}`);
    }
    if (baseline) checkDrift(urls, perSource, baseline);

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

const BASELINE_PATH = fileURLToPath(new URL('./snapshot-baseline.json', import.meta.url));

// The checksum the release build verifies before it embeds the file. It attests that the
// snapshot a release ships is the one the nightly job produced and nothing that was swapped
// in between the two — it says nothing about whether the sources themselves were honest,
// which is what the drift guard is for. Same format sha256sum -c reads, so the release job
// needs no parsing of its own; the filename in it is the basename, since the two files sit
// side by side wherever they are checked.
export function checksumLine(text, filename) {
    return `${createHash('sha256').update(text).digest('hex')}  ${filename}\n`;
}

async function main(output, { writeBaseline = false } = {}) {
    const generatedAt = new Date().toISOString();
    const texts = await fetchAll(SOURCES);

    // --write-baseline is the deliberate human bump: it records what the sources carry right
    // now and skips the guard, so it must never be what CI runs.
    const baseline = writeBaseline ? null : JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const { text, universe, perSource } = buildSnapshot({ urls: SOURCES, texts, generatedAt, baseline });

    writeFileSync(output, text);
    writeFileSync(`${output}.sha256`, checksumLine(text, output.split(/[\\/]/).pop()));

    for (const s of perSource) {
        stdout.write(`${String(s.index).padStart(2)} ${String(s.unique).padStart(6)} unique  ${shortUrl(SOURCES[s.index])}\n`);
    }
    stdout.write(`\n${universe.size} unique proxies, ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MiB -> ${output}\n`);

    if (writeBaseline) {
        writeFileSync(BASELINE_PATH, JSON.stringify(baselineFrom(SOURCES, perSource, generatedAt), null, 4) + '\n');
        stdout.write(`baseline rewritten -> ${BASELINE_PATH}\n`);
    }
}

// Run only when invoked directly, so the test can import the module without fetching.
// import.meta.main is Node 24.2+; CI runs Node 22.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
    try {
        const args = argv.slice(2);
        const writeBaseline = args.includes('--write-baseline');
        await main(args.find(a => !a.startsWith('--')) || DEFAULT_OUTPUT, { writeBaseline });
    } catch (err) {
        stderr.write(`build-snapshot: ${err.message || err}\n`);
        exit(1);
    }
}
