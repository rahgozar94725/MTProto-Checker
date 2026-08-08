// proxyLine builds every text artifact the user walks away with — the copy button, the
// plain-text panel, and the TXT export — so its exact shape and, above all, the fact that
// it carries the secret-bearing link through untouched are pinned here. pingClass is
// asserted on both sides of each threshold, because an off-by-one only ever shows up as a
// badge in the wrong colour.
import test from 'node:test';
import assert from 'node:assert/strict';

import { proxyLine, pingClass } from '../../public/js/format.js';

test('proxyLine renders link and ping in the pinned format', () => {
    assert.equal(
        proxyLine({ link: 'tg://proxy?server=192.0.2.10&port=443&secret=ee00', ping: 42 }),
        'tg://proxy?server=192.0.2.10&port=443&secret=ee00 # Ping: 42ms'
    );
});

test('proxyLine preserves the full secret-bearing link verbatim', () => {
    const link = 'https://t.me/proxy?server=192.0.2.11&port=8443&secret=' +
        'ee1a2b3c4d5e6f70718293a4b5c6d7e8f9746c656772616d2e6f7267';
    const line = proxyLine({ link, ping: 137 });
    assert.ok(line.startsWith(link), 'the link must lead the line, unmodified');
    assert.equal(line, `${link} # Ping: 137ms`);
});

test('proxyLine ignores fields other than link and ping', () => {
    assert.equal(
        proxyLine({ link: 'tg://proxy?server=192.0.2.12&port=443&secret=ee00', ping: 7, server: '192.0.2.12', port: 443 }),
        'tg://proxy?server=192.0.2.12&port=443&secret=ee00 # Ping: 7ms'
    );
});

test('pingClass is p-fast below 180ms', () => {
    assert.equal(pingClass(0), 'p-fast');
    assert.equal(pingClass(179), 'p-fast');
});

test('pingClass is p-mid from 180ms up to but not including 300ms', () => {
    assert.equal(pingClass(180), 'p-mid');
    assert.equal(pingClass(299), 'p-mid');
});

test('pingClass is p-slow from 300ms upward', () => {
    assert.equal(pingClass(300), 'p-slow');
    assert.equal(pingClass(9999), 'p-slow');
});
