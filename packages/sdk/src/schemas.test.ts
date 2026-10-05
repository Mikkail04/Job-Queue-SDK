import { describe, expect, test } from "vitest";
import { QueueError } from "./errors";
import { jobEventSchema, jobSchema, listResponseSchema, statsSchema } from "./schemas";
import { parseWith } from "./parse";

// A dead job, copied from the real Go server's event stream.
const rawJob = {
  id: 6,
  type: "always-fails",
  payload: {},
  status: "dead",
  attempts: 4,
  lastError: "this job always fails",
  createdAt: "2026-10-04T05:31:12.253-04:00",
  updatedAt: "2026-10-04T05:31:14.9736038-04:00",
};

describe("jobSchema", () => {
  test("accepts a job exactly as the Go server sends it", () => {
    expect(jobSchema.parse(rawJob)).toEqual(rawJob);
  });

  test("accepts a null lastError and UTC timestamps", () => {
    const job = { ...rawJob, lastError: null, createdAt: "2026-10-04T09:31:12Z" };
    expect(jobSchema.parse(job).lastError).toBeNull();
  });

  test("ignores fields it doesn't know about", () => {
    expect(jobSchema.parse({ ...rawJob, somethingNew: 1 })).toEqual(rawJob);
  });

  test("rejects an unknown status", () => {
    expect(jobSchema.safeParse({ ...rawJob, status: "failed" }).success).toBe(false);
  });

  test("rejects a timestamp that isn't ISO 8601", () => {
    expect(jobSchema.safeParse({ ...rawJob, createdAt: "yesterday" }).success).toBe(false);
  });

  test("rejects a missing field", () => {
    const { attempts: _attempts, ...withoutAttempts } = rawJob;
    expect(jobSchema.safeParse(withoutAttempts).success).toBe(false);
  });
});

describe("statsSchema", () => {
  test("accepts the shape /stats returns", () => {
    const stats = { dead: 0, pending: 3, running: 2, succeeded: 0 };
    expect(statsSchema.parse(stats)).toEqual(stats);
  });

  test("rejects stats with a missing status", () => {
    expect(statsSchema.safeParse({ pending: 1, running: 0, succeeded: 0 }).success).toBe(false);
  });
});

describe("listResponseSchema", () => {
  test("accepts an empty list and a list of jobs", () => {
    expect(listResponseSchema.parse({ jobs: [] }).jobs).toEqual([]);
    expect(listResponseSchema.parse({ jobs: [rawJob] }).jobs).toHaveLength(1);
  });
});

describe("jobEventSchema", () => {
  test("accepts every event type the server sends", () => {
    for (const type of ["enqueued", "started", "succeeded", "retrying", "dead", "requeued"]) {
      expect(jobEventSchema.safeParse({ type, job: rawJob }).success).toBe(true);
    }
  });

  test("rejects an unknown event type", () => {
    expect(jobEventSchema.safeParse({ type: "exploded", job: rawJob }).success).toBe(false);
  });
});

describe("parseWith", () => {
  test("returns typed data when it matches", () => {
    expect(parseWith(jobSchema, rawJob, "job").id).toBe(6);
  });

  test("throws a QueueError that says what was being parsed", () => {
    expect(() => parseWith(statsSchema, {}, "stats")).toThrow(QueueError);
    expect(() => parseWith(statsSchema, {}, "stats")).toThrow(/stats/);
  });
});