import { z } from "zod";

export const jobStatusSchema = z.enum(["pending", "running", "succeeded", "dead"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

// The Go server sends times like "2026-10-04T05:24:52.3213-04:00". They carry a
// timezone offset, which Zod rejects unless offset: true is set.
const timestamp = z.iso.datetime({ offset: true });

export const jobSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
  status: jobStatusSchema,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Job = z.infer<typeof jobSchema>;

export const statsSchema = z.object({
  pending: z.number().int(),
  running: z.number().int(),
  succeeded: z.number().int(),
  dead: z.number().int(),
});
export type Stats = z.infer<typeof statsSchema>;

export const listResponseSchema = z.object({
  jobs: z.array(jobSchema),
});

export const eventTypeSchema = z.enum([
  "enqueued",
  "started",
  "succeeded",
  "retrying",
  "dead",
  "requeued",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const jobEventSchema = z.object({
  type: eventTypeSchema,
  job: jobSchema,
});
export type JobEvent = z.infer<typeof jobEventSchema>;