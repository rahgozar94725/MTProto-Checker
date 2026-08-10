// Reads the snapshot file produced by scripts/build-snapshot.mjs. Pure by the same contract
// parse.js holds: no DOM, no fetch, no module-level mutable state.
//
// The grammar is
//
//   # generated <ISO8601> by scripts/build-snapshot.mjs
//   # <index> <short url of that source>
//   …
//   tg://proxy?server=…&port=443&secret=…#seen=1;src=8
//
// Two rules follow from the writer's side (see scripts/build-snapshot.mjs):
//
//   1. The fragment is stripped *before* the line is parsed. `new URL().search` ends at the
//      `#`, so a line parsed whole would carry `#seen=…` inside the secret.
//   2. The stripped link is what reaches the caller. `parseLink().proxy.original` is that
//      link and nothing else — the fragment must never reach a copy or an export, because
//      it would travel to `workingProxies[].link` and out through every artifact.
//
// Everything here is total: a missing header, an unparseable body, a `src=` id no header
// line declares, or no argument at all yields empty structures rather than a throw. The
// input is a file fetched over the network and the caller is the UI's boot path.

import { parseLink, proxyKey } from './parse.js';
import { DEFAULT_SOURCES, DEFAULT_SOURCE_OWNERS } from './sources.js';

const GENERATED_RE = /^#\s*generated\s+(\S+)/;
// The index is bounded because `sources[Number(id)] = url` on a sparse array is an allocation
// the header controls: `# 4294967294 x` gives every later read of that array a four-billion
// slot walk, and rateBySourceId() maps over it on the way into a scan — the page loads and
// then freezes on Start. Four digits is an order of magnitude past the 17 real sources, and a
// line that overruns it fails the match entirely, which parseSnapshot already treats as a
// comment. Only reachable through a compromised snapshot branch, and it costs nothing.
const SOURCE_RE = /^#\s*(\d{1,4})\s+(\S+)/;
// Only the exact grammar counts as attribution; anything else is a source-side comment.
//
// All three quantities are bounded, for the same reason the header index is. `seen=` past
// Number's range reads back as Infinity, and `Infinity - Infinity` is the NaN that would make
// orderForScan's comparator inconsistent rather than merely wrong. Each `src=` id is bounded in
// digits, and the *list* is bounded in length — without the second bound one line could declare
// half a million ids inside the 1 MiB per-source cap, and every id is walked again by
// bestRate(), dropDisabledSources() and tally(). 32 is an order of magnitude past the 17 real
// sources. A fragment that overruns any of them fails the match, which leaves the line's link
// intact and unattributed — what an undeclared `src=` id already does.
const FRAGMENT_RE = /^seen=(\d{1,6});src=(\d{1,4}(?:,\d{1,4}){0,31})$/;

// → { link, fragment }: everything before the first `#` and everything after it.
//
// The one place that rule is written down. Three callers depend on agreeing about where a link
// ends — parseSnapshot below, scripts/build-snapshot.mjs when it collects the corpus, and
// app.js when it loads a user's own source list — and they fail differently when they drift.
// The builder's failure is a padded secret in the collected key; the client's is a comment
// riding `parseLink().proxy.original` all the way out through the clipboard and the exports,
// so a line like `tg://…&secret=ee00# MTProto EU (100)` is copied back as
// `tg://…&secret=ee00# MTProto EU (100) # Ping: 120ms`.
export function splitFragment(line) {
    const hash = line.indexOf('#');
    if (hash === -1) return { link: line.trimEnd(), fragment: '' };

    return { link: line.slice(0, hash).trimEnd(), fragment: line.slice(hash + 1) };
}

// → { generatedAt, sources, links, attribution }
//   generatedAt  the ISO string off the header, '' when there is no header line
//   sources      index → short url, indexed by the id used in `src=`, exactly as the file
//                claims it — pass it through resolveSourceUrls before acting on it
//   links        fragment-free links in file order, i.e. in scan order
//   attribution  Map<proxyKey, {seen, srcs}>, absent for a line without the fragment
export function parseSnapshot(text = '') {
    const sources = [];
    const links = [];
    const attribution = new Map();
    let generatedAt = '';

    for (const raw of text.split('\n')) {
        const line = raw.trim();

        if (line.startsWith('#')) {
            const generated = GENERATED_RE.exec(line);
            if (generated) generatedAt = generated[1];
            else {
                const source = SOURCE_RE.exec(line);
                if (source) sources[Number(source[1])] = source[2];
            }
            continue;
        }

        const { link: bare, fragment } = splitFragment(line);
        const result = parseLink(bare);
        if (!result.ok) continue;

        links.push(result.proxy.original);

        const meta = FRAGMENT_RE.exec(fragment);
        if (meta) {
            // Distinct, because the comparison below is the whole guard and the raw list length
            // is not what `seen` means. `src=0,0,…,0` is one source named 32 times, and counting
            // it as 32 publishers is the same lie as an inflated `seen=` written on its own.
            const srcs = [...new Set(meta[2].split(',').map(Number))];
            // `seen` is how many sources published the proxy, and the writer emits exactly
            // `srcs.length` — so a line where they disagree was not written by the builder. It
            // is the *first* scan-order key (orderForScan sorts on it before source score), so
            // a compromised snapshot branch could otherwise pin an attacker-operated proxy to
            // the head of every user's next scan with one inflated number.
            if (Number(meta[1]) === srcs.length) {
                attribution.set(proxyKey(result.proxy), { seen: countPublishers(srcs), srcs });
            }
        }
    }

    return { generatedAt, sources, links, attribution };
}

// `seen` is evidence of independent corroboration, so it counts publishers rather than files.
// Ten of the seventeen defaults are one GitHub account, and the number this returns is the
// first key orderForScan sorts on — so counting ids meant one compromised account could write
// one line into ten of its own files and land it above essentially every genuinely redundant
// proxy, in every user's next scan. The dedupe above stops a line *claiming* ten ids it does
// not have; this stops ten ids that are really one publisher from meaning ten.
//
// It is derived here rather than read off the line, and from this build's own source list
// rather than the file's header, because a branch that can write the lines can write the
// header too — and it is the reader that has to hold, since snapshots published before this
// change are still out there and still loaded by one click.
//
// An id this reader cannot resolve contributes nothing. It is deliberately not counted as an
// unknown publisher of its own: `src=100,101,…` is 32 ids no header ever has to declare, which
// would hand the ranking straight back. The srcs themselves are still recorded, so
// dropDisabledSources can still answer "did any source the user disabled publish this", and a
// proxy whose ids are all unknown simply ranks like an unattributed one — the safe direction
// for a client older than the snapshot it just fetched.
function countPublishers(srcs) {
    const owners = new Set();
    for (const id of srcs) {
        const owner = DEFAULT_SOURCE_OWNERS[id];
        if (owner !== undefined) owners.add(owner);
    }
    return owners.size;
}

// → what a `src=` id actually names: this build's own DEFAULT_SOURCES for every id that list
// covers, the file's header only for ids past it.
//
// `sources` above is what the file *claims*, and a branch that can write the lines writes the
// header too — the reasoning countPublishers already follows for `seen`. The other two
// consumers of the same ids were left trusting it. dropDisabledSources maps a disabled
// source's url back to the ids to drop, so a header relabelling source 0 as a url this model
// has never heard of leaves that set empty and every link of a source the user explicitly
// disabled loads and is scanned; the same one-word edit skews rateBySourceId, the second
// scan-order key. Neither is a judgement the header gets to make.
//
// `src=` ids are positions in DEFAULT_SOURCES, so for every id this build covers the header is
// redundant and the model already holds the answer. Past that the header is the only answer
// there is — a client older than the snapshot it just fetched — and is kept.
//
// A header slot that holds no string is left as a hole rather than copied across: rateBySourceId
// maps over this array, and Array.prototype.map skips holes but hands `undefined` to shortUrl(),
// which would throw on it.
export function resolveSourceUrls(sources = []) {
    const resolved = DEFAULT_SOURCES.slice();
    for (let id = DEFAULT_SOURCES.length; id < sources.length; id++) {
        if (typeof sources[id] === 'string') resolved[id] = sources[id];
    }
    return resolved;
}
