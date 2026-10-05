import { describe, expect, test } from "vitest";
import { QueueClient } from "./client";
import { QueueError } from "./errors";

interface Call {
  url: string;
  init: RequestInit;
}

// A pending job, in the shape the Go server sends.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Builds a client whose fetch records each request and answers with respond(). */
function setup(respond: (call: Call) => Response, baseUrl = "http://queue.test") {
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  const client = new QueueClient({ baseUrl, apiKey: "secret", fetch: fakeFetch });
  return { client, calls };
}

function onlyCall(calls: Call[]): Call {
  const [call] = calls;
  if (!call || calls.length !== 1) {
    throw new Error(`expected exactly 1 request, got ${calls.length}`);
  }
  return call;
}

/** Waits for a promise that should fail, and returns the QueueError it failed with. */
async function caught(promise: Promise<unknown>): Promise<QueueError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof QueueError) return err;
    throw err;
  }
  throw new Error("expected the call to throw a QueueError");
}

describe("requests", () => {
  test("enqueue posts the type and payload with the API key", async () => {
    const { client, calls } = setup(() => jsonResponse(rawJob, 201));
    const job = await client.enqueue("send-email", { to: "a@b.com" });

    const call = onlyCall(calls);
    expect(call.url).toBe("http://queue.test/jobs");
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("X-API-Key")).toBe("secret");
    expect(JSON.parse(String(call.init.body))).toEqual({
      type: "send-email",
      payload: { to: "a@b.com" },
    });
    expect(job.id).toBe(6);
  });

  test("list with no options requests plain /jobs", async () => {
    const { client, calls } = setup(() => jsonResponse({ jobs: [] }));
    expect(await client.list()).toEqual([]);
    expect(onlyCall(calls).url).toBe("http://queue.test/jobs");
  });

  test("list passes the status and limit as a query string", async () => {
    const { client, calls } = setup(() => jsonResponse({ jobs: [rawJob] }));
    const jobs = await client.list({ status: "dead", limit: 5 });
    expect(onlyCall(calls).url).toBe("http://queue.test/jobs?status=dead&limit=5");
    expect(jobs).toHaveLength(1);
  });

  test("stats returns the parsed counts", async () => {
    const counts = { dead: 1, pending: 2, running: 0, succeeded: 3 };
    const { client } = setup(() => jsonResponse(counts));
    expect(await client.stats()).toEqual(counts);
  });

  test("retry posts to the job's retry URL with no body", async () => {
    const { client, calls } = setup(() => jsonResponse(rawJob));
    await client.retry(6);

    const call = onlyCall(calls);
    expect(call.url).toBe("http://queue.test/jobs/6/retry");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
  });

  test("trailing slashes on the base URL are ignored", async () => {
    const counts = { dead: 0, pending: 0, running: 0, succeeded: 0 };
    const { client, calls } = setup(() => jsonResponse(counts), "http://queue.test///");
    await client.stats();
    expect(onlyCall(calls).url).toBe("http://queue.test/stats");
  });
});

describe("failures", () => {
  test("an HTTP error carries the status and the server's message", async () => {
    const { client } = setup(() => jsonResponse({ error: "only dead jobs can be retried" }, 409));
    const err = await caught(client.retry(6));
    expect(err.status).toBe(409);
    expect(err.message).toBe("only dead jobs can be retried");
  });

  test("an error body that isn't JSON gets a default message", async () => {
    const { client } = setup(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await caught(client.stats());
    expect(err.status).toBe(502);
    expect(err.message).toBe("Request failed with HTTP 502");
  });

  test("a network failure becomes a QueueError that keeps the cause", async () => {
    const client = new QueueClient({
      baseUrl: "http://queue.test",
      apiKey: "secret",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const err = await caught(client.stats());
    expect(err.status).toBeUndefined();
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  test("a response that doesn't match the schema becomes a QueueError", async () => {
    const { client } = setup(() => jsonResponse({ pending: "lots" }));
    const err = await caught(client.stats());
    expect(err.message).toMatch(/stats/);
  });

  test("a success response that isn't JSON becomes a QueueError", async () => {
    const { client } = setup(() => new Response("not json", { status: 200 }));
    const err = await caught(client.stats());
    expect(err.status).toBe(200);
  });

  test("retry rejects an invalid id without sending a request", async () => {
    const { client, calls } = setup(() => jsonResponse(rawJob));
    await caught(client.retry(1.5));
    await caught(client.retry(0));
    expect(calls).toHaveLength(0);
  });
});