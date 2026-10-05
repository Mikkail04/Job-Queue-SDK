import { describe, expect, test } from "vitest";
import { parseSSE } from "./sse";

const encoder = new TextEncoder();

/** A stream that delivers the given chunks, then closes. */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of parseSSE(stream)) out.push(data);
  return out;
}

describe("parseSSE", () => {
  test("yields the data of each event", async () => {
    const stream = streamOf([': connected\n\ndata: {"a":1}\n\ndata: {"a":2}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  test("handles chunks that split a line or an event", async () => {
    const stream = streamOf(["da", "ta: hel", "lo\n", "\ndata: wor", "ld\n\n"]);
    expect(await collect(stream)).toEqual(["hello", "world"]);
  });

  test("handles \\r\\n line endings", async () => {
    expect(await collect(streamOf(["data: x\r\n\r\n"]))).toEqual(["x"]);
  });

  test("handles a \\r\\n split between two chunks", async () => {
    expect(await collect(streamOf(["data: y\r", "\n\r\n"]))).toEqual(["y"]);
  });

  test("ignores comments and keepalive pings", async () => {
    const stream = streamOf([": keepalive\n\n: keepalive\n\ndata: z\n\n"]);
    expect(await collect(stream)).toEqual(["z"]);
  });

  test("joins multiple data lines with a newline", async () => {
    expect(await collect(streamOf(["data: a\ndata: b\n\n"]))).toEqual(["a\nb"]);
  });

  test("discards an event cut off by the connection closing", async () => {
    expect(await collect(streamOf(["data: ok\n\ndata: cut"]))).toEqual(["ok"]);
  });

  test("keeps a multi-byte character that is split across chunks", async () => {
    const bytes = encoder.encode("data: é\n\n"); // é is 2 bytes, at positions 6 and 7
    const stream = streamOf([bytes.slice(0, 7), bytes.slice(7)]);
    expect(await collect(stream)).toEqual(["é"]);
  });

  test("cancels the stream when the consumer stops early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: 1\n\ndata: 2\n\n"));
        // never closes, like a live connection
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const data of parseSSE(stream)) {
      expect(data).toBe("1");
      break;
    }
    expect(cancelled).toBe(true);
  });
});