/** Thrown for every failure the SDK reports: network errors, HTTP errors, and bad responses. */
export class QueueError extends Error {
  /** The HTTP status code, when the failure came from an HTTP response. */
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QueueError";
    this.status = options.status;
  }
}