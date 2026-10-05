import { describe, expect, test } from "vitest";
import { QueueClient } from "./client";
import { QueueError } from "./errors";

const encoder = new TextEncoder();

const rawJob = {
  id: 6,
  type: "send-email",
  payload: { to: "a@b.com" },
  status: "pending",
  attempts: 0,
  lastError: null,
  createdAt: "2026-10-04T05:31:12.253-04:00",
  updatedAt: "2026-10-04T05:31:12.2566684-04:00",
};

/** One event, formatted the way the Go server sends it. */
function eventLine(type: string, job: unknown = rawJob): string {
  return `data: ${JSON.stringify({ type, job })}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function clientWith(fakeFetch: typeof fetch): QueueClient {
  return new QueueClient({ baseUrl: "http://queue.test", apiKey: "secret", fetch: fakeFetch });
}

/** Waits for a promise that should fail, and returns the QueueError it failed with. */
async function caught(promise: Promise<unknown>): Promise<QueueError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof QueueError) return err;
    throw err;
  }
  throw new Error("expected a QueueError");
}

async function drain(client: QueueClient): Promise<void> {
  for await (const event of client.subscribe()) {
    void event;
  }
}

describe("subscribe", () => {
  test("yields typed events in order and sends the API key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = clientWith(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return streamResponse([": connected\n\n", eventLine("enqueued"), eventLine("started")]);
    });

    const types: string[] = [];
    for await (const event of client.subscribe()) {
      expect(event.job.id).toBe(6);
      types.push(event.type);
    }

    expect(types).toEqual(["enqueued", "started"]); // the loop also ended when the stream closed
    const [call] = calls;
    expect(call?.url).toBe("http://queue.test/events");
    expect(new Headers(call?.init.headers).get("X-API-Key")).toBe("secret");
    expect(new Headers(call?.init.headers).get("Accept")).toBe("text/event-stream");
  });

  test("an HTTP error carries the status and the server's message", async () => {
    const client = clientWith(
      async () =>
        new Response(JSON.stringify({ error: "missing or invalid API key" }), { status: 401 }),
    );
    const err = await caught(drain(client));
    expect(err.status).toBe(401);
    expect(err.message).toBe("missing or invalid API key");
  });

  test("an event that isn't JSON becomes a QueueError", async () => {
    const client = clientWith(async () => streamResponse(["data: not json\n\n"]));
    const err = await caught(drain(client));
    expect(err.message).toMatch(/not valid JSON/);
  });

  test("an event that doesn't match the schema becomes a QueueError", async () => {
    const client = clientWith(async () => streamResponse([eventLine("exploded")]));
    const err = await caught(drain(client));
    expect(err.message).toMatch(/event/);
  });

  test("a connection failure becomes a QueueError that keeps the cause", async () => {
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await caught(drain(client));
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  test("aborting the signal ends the stream without an error", async () => {
    const client = clientWith(async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(eventLine("enqueued")));
          // a live connection: it stays open until the signal aborts it
          signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, { status: 200 });
    });

    const abort = new AbortController();
    const seen: string[] = [];
    for await (const event of client.subscribe({ signal: abort.signal })) {
      seen.push(event.type);
      abort.abort();
    }
    expect(seen).toEqual(["enqueued"]);
  });

  test("breaking out of the loop closes the connection", async () => {
    let cancelled = false;
    const client = clientWith(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(eventLine("enqueued") + eventLine("started")));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });

    for await (const event of client.subscribe()) {
      expect(event.type).toBe("enqueued");
      break;
    }
    expect(cancelled).toBe(true);
  });
});