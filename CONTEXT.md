# MTProto Checker

A local tool that takes a pasted list of Telegram MTProto proxy links and reports which ones actually work, ranked by response time.

## Language

### Proxies

**Proxy Link**:
A single pasted URL naming one proxy — the `tg://proxy?server=…&port=…&secret=…` form or its `https://t.me/proxy` equivalent.
_Avoid_: entry, line, URL

**Proxy**:
The endpoint a Proxy Link names: server, port and secret together.
_Avoid_: node, host, server

**Proxy Key**:
The identity of a Proxy, written `server:port:secret`. Two Proxy Links with the same Proxy Key name the same Proxy.
_Avoid_: id, hash, fingerprint

### Scanning

**Scan**:
One run over a list of Proxies, from the user starting it until it ends. Pausing and resuming stay inside the same Scan; starting again begins a new one.
_Avoid_: check, session, scan session, batch, run

**Check**:
One MTProto handshake against one Proxy. A Scan is many Checks.
_Avoid_: test, probe, ping, verification

**Ping**:
The round-trip time of a successful Check, in milliseconds. It measures the handshake, not an ICMP echo.
_Avoid_: latency, response time

### Outcomes

**Working**:
A Proxy whose Check completed the handshake within the timeout. Only Working Proxies reach the results.
_Avoid_: alive, valid, good, ok

**Invalid**:
A pasted line that yields no Proxy at all — no scheme, a missing parameter, or an out-of-range port.
_Avoid_: bad link, malformed

**Skipped**:
A line that parses into a Proxy but is dropped before any Check because its secret trips the spam filter.
_Avoid_: filtered, rejected

**Duplicate**:
A Proxy Link whose Proxy Key already appeared earlier in the same paste. The Proxy is Checked once.
_Avoid_: repeat, copy
