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

const GENERATED_RE = /^#\s*generated\s+(\S+)/;
const SOURCE_RE = /^#\s*(\d+)\s+(\S+)/;
// Only the exact grammar counts as attribution; anything else is a source-side comment.
const FRAGMENT_RE = /^seen=(\d+);src=(\d+(?:,\d+)*)$/;

// → { generatedAt, sources, links, attribution }
//   generatedAt  the ISO string off the header, '' when there is no header line
//   sources      index → short url, indexed by the id used in `src=`
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

        const hash = line.indexOf('#');
        const result = parseLink(hash === -1 ? line : line.slice(0, hash));
        if (!result.ok) continue;

        links.push(result.proxy.original);

        const meta = FRAGMENT_RE.exec(hash === -1 ? '' : line.slice(hash + 1));
        if (meta) {
            attribution.set(proxyKey(result.proxy), {
                seen: Number(meta[1]),
                srcs: meta[2].split(',').map(Number),
            });
        }
    }

    return { generatedAt, sources, links, attribution };
}
