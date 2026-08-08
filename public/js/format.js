// Presentation-only helpers, kept pure so tests/unit/format.test.js can pin them without a
// DOM. proxyLine is the single formatter behind every text artifact the user exports —
// row copy, copy-all, the plain-text panel and the TXT export all go through it, so its
// shape is a user-visible contract. The JSON export builds its own objects instead.

// The full link, secret included, must survive verbatim — it is the only part of a result
// that is worth anything once it leaves the app.
export function proxyLine(p) {
    return `${p.link} # Ping: ${p.ping}ms`;
}

// Badge colour thresholds, matching the .p-fast/.p-mid/.p-slow rules in components.css.
export function pingClass(ping) {
    if (ping < 180) return 'p-fast';
    if (ping < 300) return 'p-mid';
    return 'p-slow';
}
