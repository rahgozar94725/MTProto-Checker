// Builders for SSE wire bodies, so the frame-parser tests describe what the server sends
// rather than hand-assembling escape sequences at every call site. The shapes here mirror
// what /check-stream actually writes: an `event:` line, a `data:` line, blank-line
// terminator.

// One wire frame. `event` is optional so a data-only frame can be built, and `data` is
// optional so a frame the parser must drop can be built.
export function frame({ event, data } = {}) {
    let out = '';
    if (event !== undefined) out += `event: ${event}\n`;
    if (data !== undefined) out += `data: ${data}\n`;
    return `${out}\n`;
}

// A progress frame carrying the JSON payload the server sends per checked proxy.
export function progressFrame(payload) {
    return frame({ event: 'progress', data: JSON.stringify(payload) });
}

export function doneFrame(payload = { completed: 0 }) {
    return frame({ event: 'done', data: JSON.stringify(payload) });
}

// A whole response body: every frame concatenated, exactly as it arrives over the wire.
export function body(frames) {
    return frames.join('');
}

// Split `text` at the given absolute offsets, so a test can cut a body anywhere — mid-frame,
// mid-`data:` line, mid-terminator — and feed the pieces to push() in order.
export function chunkAt(text, ...offsets) {
    const cuts = [0, ...offsets, text.length];
    const chunks = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const piece = text.slice(cuts[i], cuts[i + 1]);
        if (piece) chunks.push(piece);
    }
    return chunks;
}

// Every fixed-size slice of `text`, for driving a body through the parser one byte at a time.
export function chunksOf(text, size) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    return chunks;
}
