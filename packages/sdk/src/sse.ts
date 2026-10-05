/**
 * Reads a Server-Sent Events stream and yields the data of each event.
 *
 * Comment lines (the server's ": keepalive" pings) are skipped. An event cut off
 * by a dropped connection is discarded, as the SSE spec says. Lines may end in
 * \n or \r\n; a lone \r is not supported.
 *
 * Breaking out of a for-await loop over this generator cancels the stream,
 * which closes the connection.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;

      // stream: true keeps a multi-byte character that was split across chunks intact.
      // Normalizing the whole buffer (not just the new chunk) also handles a
      // \r\n that was split between two chunks.
      buffer = (buffer + decoder.decode(result.value, { stream: true })).replace(/\r\n/g, "\n");

      // A blank line ends an event.
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const data = dataOf(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data !== undefined) yield data;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Runs when the stream ends, fails, or the consumer stops early.
    await reader.cancel().catch(() => {});
  }
}

/** Joins the "data:" lines of one event block, or returns undefined if it has none. */
function dataOf(block: string): string | undefined {
  const lines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue; // comments and other fields
    const value = line.slice("data:".length);
    lines.push(value.startsWith(" ") ? value.slice(1) : value); // one leading space is optional
  }
  return lines.length === 0 ? undefined : lines.join("\n");
}