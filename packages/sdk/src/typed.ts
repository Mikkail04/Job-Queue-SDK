import type { z } from "zod";
import type { QueueClient } from "./client";
import { QueueError } from "./errors";
import type { Job } from "./schemas";

/** Maps each job type name to the Zod schema of its payload. */
export type PayloadSchemas = { [type: string]: z.ZodType };

/**
 * A job whose payload type depends on its type. This is a union with one member
 * per registered job type, so checking job.type narrows job.payload:
 *
 *   switch (job.type) {
 *     case "send-email": job.payload.to;    // string
 *     case "resize-image": job.payload.width; // number
 *   }
 */
export type TypedJob<S extends PayloadSchemas> = {
  [K in keyof S & string]: Omit<Job, "type" | "payload"> & { type: K; payload: z.output<S[K]> };
}[keyof S & string];

/**
 * Wraps a QueueClient so job payloads are checked. Pass the schemas once:
 *
 *   const typed = new TypedQueueClient(client, {
 *     "send-email": z.object({ to: z.email() }),
 *   });
 *   await typed.enqueue("send-email", { to: "a@b.com" }); // type-checked
 *
 * The plain client is available as `typed.client` for list(), stats(), retry(),
 * and subscribe().
 */
export class TypedQueueClient<S extends PayloadSchemas> {
  readonly client: QueueClient;
  private readonly schemaMap: Readonly<Record<string, z.ZodType>>;

  constructor(client: QueueClient, schemas: S) {
    this.client = client;
    this.schemaMap = schemas;
  }

  /**
   * Adds a job. The type name and payload are checked by the compiler, and the
   * payload is validated again at runtime before anything is sent. What gets
   * sent is the schema's output, so defaults and transforms are applied.
   */
  async enqueue<K extends keyof S & string>(type: K, payload: z.input<S[K]>): Promise<Job> {
    const result = this.schemaFor(type).safeParse(payload);
    if (!result.success) {
      throw new QueueError(`Invalid payload for job type "${type}": ${result.error.message}`, {
        cause: result.error,
      });
    }
    return this.client.enqueue(type, result.data);
  }

  /**
   * Checks a job's payload against the schema for its type and returns it typed.
   * Throws a QueueError if the type isn't registered or the payload doesn't match.
   */
  parseJob(job: Job): TypedJob<S> {
    const result = this.schemaFor(job.type).safeParse(job.payload);
    if (!result.success) {
      throw new QueueError(
        `Job ${job.id} has an invalid "${job.type}" payload: ${result.error.message}`,
        { cause: result.error },
      );
    }
    // The cast is safe: the schema was chosen by job.type, so the payload now
    // matches the member of the union with that type. TypeScript can't see that
    // through a generic mapped type.
    return { ...job, payload: result.data } as unknown as TypedJob<S>;
  }

  private schemaFor(type: string): z.ZodType {
    // hasOwn keeps names like "constructor" from matching Object.prototype.
    const schema = Object.hasOwn(this.schemaMap, type) ? this.schemaMap[type] : undefined;
    if (!schema) {
      throw new QueueError(`No payload schema registered for job type "${type}"`);
    }
    return schema;
  }
}