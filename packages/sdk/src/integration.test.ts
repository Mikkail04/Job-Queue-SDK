// These tests talk to a running Go server, so they only run when QUEUE_URL and
// QUEUE_API_KEY are set. The server must be started with the -demo flag.

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { QueueClient } from "./client";
import { QueueError } from "./errors";
import type { JobEvent } from "./schemas";
import { TypedQueueClient } from "./typed";

const baseUrl = process.env.QUEUE_URL;
const apiKey = process.env.QUEUE_API_KEY;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until probe() returns something, or fails after timeoutMs. */
async function until<T>(timeoutMs: number, probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(25);
  }
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

describe.skipIf(!baseUrl || !apiKey)("against the real Go server", () => {
  const client = new QueueClient({ baseUrl: baseUrl ?? "", apiKey: apiKey ?? "" });
  const typed = new TypedQueueClient(client, {
    "send-email": z.object({ to: z.email() }),
    "always-fails": z.object({}),
  });

  /** Collects every event from the stream, until the signal is aborted. */
  function listen(signal: AbortSignal) {
    const events: JobEvent[] = [];
    const done = (async () => {
      for await (const event of client.subscribe({ signal })) events.push(event);
    })();
    return { events, done };
  }

  test("stats returns a count for every status", async () => {
    const stats = await client.stats();
    expect(Object.keys(stats).sort()).toEqual(["dead", "pending", "running", "succeeded"]);
  });

  test("a wrong API key is rejected with 401", async () => {
    const bad = new QueueClient({ baseUrl: baseUrl ?? "", apiKey: "wrong-key" });
    const err = await caught(bad.stats());
    expect(err.status).toBe(401);
  });

  test("retrying a job that doesn't exist fails with 404", async () => {
    const err = await caught(client.retry(999_999_999));
    expect(err.status).toBe(404);
  });

  test("an enqueued job appears in list() and in the event stream", async () => {
    const abort = new AbortController();
    const { events, done } = listen(abort.signal);
    try {
      // Give the stream a moment to connect, so it can't miss this job's first event.
      await sleep(300);
      const job = await typed.enqueue("send-email", { to: "a@b.com" });
      expect(job.type).toBe("send-email");

      const listed = await client.list({ limit: 50 });
      expect(listed.some((j) => j.id === job.id)).toBe(true);

      await until(5_000, () => events.find((e) => e.job.id === job.id && e.type === "enqueued"));
      await until(5_000, () => events.find((e) => e.job.id === job.id && e.type === "started"));
    } finally {
      abort.abort();
      await done;
    }
  }, 15_000);

  test("a failing job dies, and retry() gives it a fresh start", async () => {
    const abort = new AbortController();
    const { events, done } = listen(abort.signal);
    try {
      await sleep(300);
      const job = await typed.enqueue("always-fails", {});

      // Four attempts with growing waits between them takes a few seconds.
      const dead = await until(20_000, () =>
        events.find((e) => e.job.id === job.id && e.type === "dead"),
      );
      expect(dead.job.attempts).toBe(4);
      expect(dead.job.lastError).toBe("this job always fails");

      const retried = await client.retry(job.id);
      expect(retried.status).toBe("pending");
      expect(retried.attempts).toBe(0);

      const requeued = await until(5_000, () =>
        events.find((e) => e.job.id === job.id && e.type === "requeued"),
      );
      expect(requeued.job.lastError).toBeNull();
    } finally {
      abort.abort();
      await done;
    }
  }, 30_000);
});