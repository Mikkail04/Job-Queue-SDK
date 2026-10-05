import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { QueueClient } from "./client";
import { QueueError } from "./errors";
import type { Job } from "./schemas";
import { TypedQueueClient } from "./typed";
import type { TypedJob } from "./typed";

const schemas = {
  "send-email": z.object({ to: z.email(), subject: z.string().default("(no subject)") }),
  "resize-image": z.object({ url: z.url(), width: z.number().int().positive() }),
};

const baseJob: Job = {
  id: 6,
  type: "send-email",
  payload: null,
  status: "pending",
  attempts: 0,
  lastError: null,
  createdAt: "2026-10-04T05:31:12.253-04:00",
  updatedAt: "2026-10-04T05:31:12.2566684-04:00",
};

/** Compiles only if checking job.type narrows job.payload. */
function summarize(job: TypedJob<typeof schemas>): string {
  switch (job.type) {
    case "send-email":
      return `${job.payload.to}: ${job.payload.subject}`;
    case "resize-image":
      return `${job.payload.url} at ${job.payload.width}px`;
  }
}

/** A typed client whose fetch records each request body and answers with baseJob. */
function setup() {
  const bodies: unknown[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(baseJob), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = new QueueClient({ baseUrl: "http://queue.test", apiKey: "secret", fetch: fakeFetch });
  return { typed: new TypedQueueClient(client, schemas), bodies };
}

// The "@ts-expect-error" lines below are checked by `pnpm typecheck`: if the
// line underneath ever stops being a compile error, the typecheck fails.
describe("enqueue", () => {
  test("sends the validated payload, with defaults filled in", async () => {
    const { typed, bodies } = setup();
    await typed.enqueue("send-email", { to: "a@b.com" }); // subject is optional on input
    expect(bodies).toEqual([
      { type: "send-email", payload: { to: "a@b.com", subject: "(no subject)" } },
    ]);
  });

  test("rejects a payload with the wrong shape, and sends nothing", async () => {
    const { typed, bodies } = setup();
    // @ts-expect-error width must be a number
    await expect(typed.enqueue("resize-image", { url: "https://x.test/a.png", width: "wide" })).rejects.toThrow(/resize-image/);
    expect(bodies).toHaveLength(0);
  });

  test("rejects a payload with a missing field, and sends nothing", async () => {
    const { typed, bodies } = setup();
    // @ts-expect-error "to" is required
    await expect(typed.enqueue("send-email", {})).rejects.toThrow(QueueError);
    expect(bodies).toHaveLength(0);
  });

  test("rejects a job type that isn't registered, and sends nothing", async () => {
    const { typed, bodies } = setup();
    // @ts-expect-error "sms" is not a registered job type
    await expect(typed.enqueue("sms", {})).rejects.toThrow(/sms/);
    expect(bodies).toHaveLength(0);
  });
});

describe("parseJob", () => {
  test("returns a job whose payload type follows its type, with defaults applied", () => {
    const { typed } = setup();
    const email = typed.parseJob({ ...baseJob, type: "send-email", payload: { to: "a@b.com" } });
    expect(summarize(email)).toBe("a@b.com: (no subject)");

    const image = typed.parseJob({
      ...baseJob,
      type: "resize-image",
      payload: { url: "https://x.test/a.png", width: 640 },
    });
    expect(summarize(image)).toBe("https://x.test/a.png at 640px");
    expectTypeOf(image.type).toEqualTypeOf<"send-email" | "resize-image">();
  });

  test("throws for a job type that isn't registered", () => {
    const { typed } = setup();
    expect(() => typed.parseJob({ ...baseJob, type: "sms" })).toThrow(/sms/);
  });

  test("throws for a payload that doesn't match its schema", () => {
    const { typed } = setup();
    expect(() => typed.parseJob({ ...baseJob, payload: { to: "not an email" } })).toThrow(/Job 6/);
  });

  test("doesn't treat names from Object.prototype as registered types", () => {
    const { typed } = setup();
    expect(() => typed.parseJob({ ...baseJob, type: "constructor" })).toThrow(QueueError);
  });
});