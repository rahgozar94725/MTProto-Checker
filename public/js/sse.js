// Server-Sent Events frame reassembly for /check-stream. A network chunk is not a frame:
// one read can carry two results, half a result, or a byte of one. Keeping the buffering
// here — instead of inline in the fetch loop — is what makes chunk boundaries testable
// without a server.
//
// `data` is handed back as the raw string. JSON.parse stays with the caller so a malformed
// payload still throws in the scan loop, exactly where it did before this was extracted.

// → { push(chunk) } — each push returns the frames completed by that chunk, in order, and
// keeps any trailing partial frame buffered for the next one.
export function createSSEParser() {
    let buffer = '';

    return {
        push(chunk) {
            buffer += chunk;

            // The last element is whatever follows the final terminator: either '' when the
            // chunk ended on a frame boundary, or an incomplete frame to carry forward.
            const parts = buffer.split('\n\n');
            buffer = parts.pop();

            const frames = [];
            for (const part of parts) {
                if (!part.trim()) continue;

                let event = '';
                let data = '';
                for (const line of part.split('\n')) {
                    if (line.startsWith('event: ')) event = line.slice(7);
                    else if (line.startsWith('data: ')) data = line.slice(6);
                }

                // A frame with no payload carries nothing to act on — comments and
                // keep-alives land here and are dropped, as they always were.
                if (!data) continue;

                frames.push({ event, data });
            }
            return frames;
        }
    };
}
