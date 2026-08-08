// The link parser is the only code between an attacker-controlled paste and the network,
// and until this suite it had never been tested. Every rule below is the behaviour the
// classic script shipped with — including the surprising ones, which are pinned on purpose
// rather than fixed. The golden replay at the bottom is the proof that the ES-module
// rewrite preserved all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    parseLink,
    parseProxyList,
    proxyKey,
    isAcceptedFilename,
    ACCEPTED_EXTENSIONS,
} from '../../public/js/parse.js';

const repoPath = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

// --- parseLink: accepted forms -------------------------------------------------------

test('parses a tg:// link into server, port and secret', () => {
    const r = parseLink('tg://proxy?server=192.0.2.1&port=443&secret=ee1a2b3c');
    assert.equal(r.ok, true);
    assert.deepEqual(r.proxy, {
        server: '192.0.2.1',
        port: 443,
        secret: 'ee1a2b3c',
        original: 'tg://proxy?server=192.0.2.1&port=443&secret=ee1a2b3c',
    });
});

test('parses an https://t.me/proxy link', () => {
    const r = parseLink('https://t.me/proxy?server=192.0.2.2&port=8443&secret=ee00ff');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, '192.0.2.2');
    assert.equal(r.proxy.port, 8443);
});

test('accepts any scheme, since only "://" is required', () => {
    // Surprising but current behaviour: the scheme is never validated.
    const r = parseLink('javascript://proxy?server=192.0.2.3&port=443&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, '192.0.2.3');
});

test('keeps a unicode host in the server field verbatim', () => {
    const r = parseLink('tg://proxy?server=пример.example&port=443&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, 'пример.example');
});

test('keeps a script tag in the server field as an inert string', () => {
    const r = parseLink('tg://proxy?server=%3Cscript%3Ealert(1)%3C/script%3E&port=443&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, '<script>alert(1)</script>');
});

test('trims surrounding whitespace, including a CR from CRLF input', () => {
    const r = parseLink('  tg://proxy?server=192.0.2.4&port=443&secret=ee00  \r');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.original, 'tg://proxy?server=192.0.2.4&port=443&secret=ee00');
});

test('repairs the first ".&" typo and carries the repair into original', () => {
    const r = parseLink('tg://proxy?server=192.0.2.5.&port=443&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, '192.0.2.5');
    assert.equal(r.proxy.original, 'tg://proxy?server=192.0.2.5&port=443&secret=ee00');
});

test('repairs only the first ".&" occurrence', () => {
    // String.replace with a string pattern is not global — a second typo survives.
    const r = parseLink('tg://proxy?server=192.0.2.6.&port=443.&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.server, '192.0.2.6');
    assert.equal(r.proxy.port, 443, 'the surviving "443." still parses as 443');
    assert.ok(r.proxy.original.includes('port=443.&secret=ee00'), 'the second typo is left in place');
});

test('original round-trips the full secret untouched', () => {
    const secret = 'ee' + 'a1b2c3d4'.repeat(8);
    const line = `tg://proxy?server=192.0.2.7&port=443&secret=${secret}`;
    const r = parseLink(line);
    assert.equal(r.proxy.secret, secret);
    assert.equal(r.proxy.original, line);
});

// --- parseLink: rejections -----------------------------------------------------------

test('rejects a line with no scheme separator', () => {
    const r = parseLink('proxy?server=192.0.2.8&port=443&secret=ee00');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-scheme');
});

test('rejects an empty line as no-scheme', () => {
    assert.deepEqual(parseLink(''), { ok: false, reason: 'no-scheme' });
    assert.deepEqual(parseLink('   '), { ok: false, reason: 'no-scheme' });
});

test('rejects a URL the parser cannot construct as malformed', () => {
    const r = parseLink('://?server=192.0.2.9&port=443&secret=ee00');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed');
});

test('rejects a missing server as malformed', () => {
    assert.deepEqual(parseLink('tg://proxy?port=443&secret=ee00'), { ok: false, reason: 'malformed' });
});

test('rejects a missing port as malformed', () => {
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.10&secret=ee00'), { ok: false, reason: 'malformed' });
});

test('rejects a missing secret as malformed', () => {
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.11&port=443'), { ok: false, reason: 'malformed' });
});

test('rejects an empty parameter value as malformed', () => {
    assert.deepEqual(parseLink('tg://proxy?server=&port=443&secret=ee00'), { ok: false, reason: 'malformed' });
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.12&port=443&secret='), { ok: false, reason: 'malformed' });
});

test('rejects a non-numeric port as malformed, not bad-port', () => {
    // parseInt returns NaN, which is falsy, so it fails the required-fields check first.
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.13&port=abc&secret=ee00'), { ok: false, reason: 'malformed' });
});

test('reads a trailing-junk port as its leading digits', () => {
    // parseInt('443abc') === 443. Pinned because it is load-bearing in the golden baseline.
    const r = parseLink('tg://proxy?server=192.0.2.14&port=443abc&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.port, 443);
});

test('reads a 0x-prefixed port as hexadecimal', () => {
    // parseInt without an explicit radix still honours the 0x prefix. Surprising, kept.
    const r = parseLink('tg://proxy?server=192.0.2.15&port=0x1bb&secret=ee00');
    assert.equal(r.ok, true);
    assert.equal(r.proxy.port, 443);
});

test('port 0 is malformed, because zero is falsy', () => {
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.16&port=0&secret=ee00'), { ok: false, reason: 'malformed' });
});

test('port 1 and port 65535 are accepted', () => {
    assert.equal(parseLink('tg://proxy?server=192.0.2.17&port=1&secret=ee00').proxy.port, 1);
    assert.equal(parseLink('tg://proxy?server=192.0.2.17&port=65535&secret=ee00').proxy.port, 65535);
});

test('port 65536 and above is bad-port', () => {
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.18&port=65536&secret=ee00'), { ok: false, reason: 'bad-port' });
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.18&port=70000&secret=ee00'), { ok: false, reason: 'bad-port' });
});

test('a negative port is bad-port', () => {
    assert.deepEqual(parseLink('tg://proxy?server=192.0.2.19&port=-1&secret=ee00'), { ok: false, reason: 'bad-port' });
});

test('a secret longer than 170 characters is spam', () => {
    const ok = parseLink('tg://proxy?server=192.0.2.20&port=443&secret=' + 'b'.repeat(170));
    assert.equal(ok.ok, true, '170 characters is still accepted');

    const spam = parseLink('tg://proxy?server=192.0.2.20&port=443&secret=' + 'b'.repeat(171));
    assert.deepEqual(spam, { ok: false, reason: 'spam' });
});

test('a secret containing a twenty-character A run is spam', () => {
    const spam = parseLink('tg://proxy?server=192.0.2.21&port=443&secret=ee' + 'A'.repeat(20) + '11');
    assert.deepEqual(spam, { ok: false, reason: 'spam' });

    const ok = parseLink('tg://proxy?server=192.0.2.21&port=443&secret=ee' + 'A'.repeat(19) + '11');
    assert.equal(ok.ok, true, 'nineteen A characters is under the run threshold');
});

test('the port check runs before the spam check', () => {
    // A spam secret on an out-of-range port is reported as bad-port, so it does not
    // count toward the skipped tile. This ordering is what the golden baseline recorded.
    const r = parseLink('tg://proxy?server=192.0.2.22&port=70000&secret=ee' + 'A'.repeat(30));
    assert.deepEqual(r, { ok: false, reason: 'bad-port' });
});

// --- parseProxyList ------------------------------------------------------------------

test('parseProxyList returns proxies, skipped and duplicates', () => {
    const { proxies, skipped, duplicates } = parseProxyList([
        'tg://proxy?server=192.0.2.30&port=443&secret=ee11',
        'tg://proxy?server=192.0.2.31&port=443&secret=ee22',
    ].join('\n'));

    assert.equal(proxies.length, 2);
    assert.equal(skipped, 0);
    assert.equal(duplicates, 0);
});

test('skipped counts spam secrets and only spam secrets', () => {
    const { proxies, skipped } = parseProxyList([
        'tg://proxy?server=192.0.2.32&port=443&secret=ee' + 'A'.repeat(40),
        'not a link at all',
        'tg://proxy?server=192.0.2.33&port=70000&secret=ee33',
        'tg://proxy?server=192.0.2.34&port=443&secret=ee44',
    ].join('\n'));

    assert.equal(proxies.length, 1);
    assert.equal(skipped, 1, 'the malformed and bad-port lines must not be counted');
});

test('blank lines and trailing whitespace are ignored without counting as skipped', () => {
    const { proxies, skipped } = parseProxyList(
        '\n   \ntg://proxy?server=192.0.2.35&port=443&secret=ee55   \n\n'
    );
    assert.equal(proxies.length, 1);
    assert.equal(skipped, 0);
});

test('CRLF input parses exactly like LF input', () => {
    const lines = [
        'tg://proxy?server=192.0.2.36&port=443&secret=ee66',
        'tg://proxy?server=192.0.2.37&port=443&secret=ee77',
    ];
    assert.deepEqual(
        parseProxyList(lines.join('\r\n')),
        parseProxyList(lines.join('\n'))
    );
});

test('duplicates are removed by server:port:secret with the first occurrence winning', () => {
    const { proxies, duplicates } = parseProxyList([
        'tg://proxy?server=192.0.2.38&port=443&secret=ee88',
        'https://t.me/proxy?server=192.0.2.38&port=443&secret=ee88',
        'tg://proxy?server=192.0.2.38&port=444&secret=ee88',
    ].join('\n'));

    assert.equal(proxies.length, 2);
    assert.equal(duplicates, 1);
    assert.equal(proxies[0].original, 'tg://proxy?server=192.0.2.38&port=443&secret=ee88',
        'the first form of a duplicated proxy is the one kept');
});

test('a differing secret is not a duplicate', () => {
    const { proxies, duplicates } = parseProxyList([
        'tg://proxy?server=192.0.2.39&port=443&secret=ee99',
        'tg://proxy?server=192.0.2.39&port=443&secret=eeaa',
    ].join('\n'));
    assert.equal(proxies.length, 2);
    assert.equal(duplicates, 0);
});

test('a thousand-line list parses every entry', () => {
    const text = Array.from({ length: 1000 }, (_, i) =>
        `tg://proxy?server=192.0.2.${i % 254 + 1}&port=${1000 + i}&secret=ee${i}`
    ).join('\n');
    const { proxies, skipped, duplicates } = parseProxyList(text);
    assert.equal(proxies.length, 1000);
    assert.equal(skipped, 0);
    assert.equal(duplicates, 0);
});

test('parseProxyList holds no state between calls', () => {
    const spam = 'tg://proxy?server=192.0.2.40&port=443&secret=ee' + 'A'.repeat(40);
    assert.equal(parseProxyList(spam).skipped, 1);
    assert.equal(parseProxyList(spam).skipped, 1, 'a second call must not accumulate');
    assert.equal(parseProxyList('tg://proxy?server=192.0.2.41&port=443&secret=eebb').skipped, 0);
});

// --- proxyKey and file-name acceptance -----------------------------------------------

test('proxyKey joins server, port and secret with colons', () => {
    assert.equal(
        proxyKey({ server: '192.0.2.42', port: 443, secret: 'eecc' }),
        '192.0.2.42:443:eecc'
    );
});

test('proxyKey matches the key parseProxyList dedupes on', () => {
    const { proxies } = parseProxyList('tg://proxy?server=192.0.2.43&port=443&secret=eedd');
    assert.equal(proxyKey(proxies[0]), '192.0.2.43:443:eedd');
});

test('ACCEPTED_EXTENSIONS is the three text list formats', () => {
    assert.deepEqual(ACCEPTED_EXTENSIONS, ['.txt', '.csv', '.list']);
});

test('isAcceptedFilename accepts the three extensions case-insensitively', () => {
    assert.equal(isAcceptedFilename('proxies.txt'), true);
    assert.equal(isAcceptedFilename('proxies.CSV'), true);
    assert.equal(isAcceptedFilename('MyList.List'), true);
});

test('isAcceptedFilename rejects anything else', () => {
    assert.equal(isAcceptedFilename('screenshot.png'), false);
    assert.equal(isAcceptedFilename('proxies.txt.exe'), false);
    assert.equal(isAcceptedFilename('txt'), false);
});

// --- golden replay -------------------------------------------------------------------

// The baseline was recorded under Node's URL implementation, and one fixture line —
// `file://localhost?server=…` — is accepted there but rejected by Chrome, which refuses
// to construct that URL at all. So this replay pins 227 proxies while the same fixture
// pasted into a real browser yields 226. Verified against the pre-refactor parser in
// Chrome: it also yields 226, byte-identical to this module's output, so the gap is the
// engine, not the refactor.
test('parseProxyList reproduces the pre-refactor golden baseline exactly', () => {
    const golden = JSON.parse(readFileSync(repoPath('tests/fixtures/golden/parse-baseline.json'), 'utf8'));
    const fixture = readFileSync(repoPath('tests/fixtures/proxies-dirty.txt'), 'utf8');

    const { proxies, skipped, duplicates } = parseProxyList(fixture);

    assert.equal(skipped, golden.skippedCount, 'spam count drifted from the classic script');
    assert.equal(duplicates, golden.dupCount, 'duplicate count drifted from the classic script');
    assert.equal(proxies.length, golden.proxyCount);
    assert.deepEqual(proxies, golden.proxies, 'the parsed proxy list drifted from the classic script');
});
