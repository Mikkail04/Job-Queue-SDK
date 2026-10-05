import type { z } from "zod";
import { QueueError } from "./errors";

/** Checks data against a schema and returns it typed, or throws a QueueError. */
export function parseWith<T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new QueueError(`Unexpected ${what} from the server: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}