// The mutable state of one scan, in one place.
//
// A factory rather than a shared singleton object: app.js creates exactly one
// state per module instance, and the DOM suites mount the app more than once in
// a single process. A module-level singleton would survive across mounts (the
// cache-busting import in tests/helpers/dom.js reloads app.js, not the modules
// it imports) and leak one test's results into the next.
export function createScanState() {
    return {
        // Working proxies found so far, kept sorted ascending by ping.
        workingProxies: [],
        // Spam links dropped by the last parse -- display state for #tileSkipped.
        lastSkipped: 0,
        isPaused: false,
        scanState: 'idle', // 'idle' | 'scanning'
        currentController: null,
        // "server:port:secret" keys already answered for, so a resume can skip them.
        checkedKeys: new Set(),
        // Every proxy of the current scan, in paste order.
        allProxies: [],
        // "server:port:secret" -> the original pasted link, which carries the secret.
        globalLinkMap: new Map(),
        // "server:port:secret" -> {seen, srcs} off the last loaded snapshot. Keyed by
        // identity rather than by paste, so it outlives one scan: a proxy the snapshot
        // published keeps its sources whether the user reloads the list or edits around it.
        snapshotAttribution: new Map(),
        // Last progress numbers, so a re-render does not need a new event.
        lastChecked: 0,
        lastTotal: 0,
    };
}
