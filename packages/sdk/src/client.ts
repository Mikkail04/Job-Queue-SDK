import { z } from "zod";
import { QueueError } from "./errors";
import { parseWith } from "./parse";
import { jobEventSchema, jobSchema, listResponseSchema, statsSchema } from "./schemas";
import type { Job, JobEvent, JobStatus, Stats } from "./schemas";
import { parseSSE } from "./sse";

// The Go server reports errors as {"error": "message"}.
const errorBodySchema = z.object({ error: z.string() });

export interface QueueClientOptions {
  /** Where the queue server lives, for example "http://localhost:8080". */
  baseUrl: string;
  /** Sent in the X-API-Key header on every request. */
  apiKey: string;
  /** Replaces the global fetch. Mainly useful in tests. */
  fetch?: typeof fetch;
}

export interface ListOptions {
  /** Only return jobs with this status. */
  status?: JobStatus;
  /** Return at most this many jobs, newest first. */
  limit?: number;
}

export interface SubscribeOptions {
  /** Aborting this signal ends the stream quietly, without throwing. */
  signal?: AbortSignal;
}

/** A typed client for the job queue's HTTP API. Every failure is thrown as a QueueError. */
export class QueueClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: QueueClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, ""); // drop trailing slashes
    this.apiKey = options.apiKey;
    // Binding keeps fetch working in browsers, which reject it when called as a method.
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Adds a job to the queue. */
  async enqueue(type: string, payload?: unknown): Promise<Job> {
    return this.request("POST", "/jobs", jobSchema, "job", { type, payload });
  }

  /** Lists jobs, newest first. */
  async list(options: ListOptions = {}): Promise<Job[]> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    const path = query === "" ? "/jobs" : `/jobs?${query}`;
    const response = await this.request("GET", path, listResponseSchema, "job list");
    return response.jobs;
  }

  /** Counts how many jobs are in each status. */
  async stats(): Promise<Stats> {
    return this.request("GET", "/stats", statsSchema, "stats");
  }

  /** Gives a dead job a fresh set of attempts. */
  async retry(id: number): Promise<Job> {
    if (!Number.isInteger(id) || id < 1) {
      throw new QueueError(`Invalid job id: ${id}`);
    }
    return this.request("POST", `/jobs/${id}/retry`, jobSchema, "job");
  }

  /**
   * Streams job events as they happen:
   *
   *   for await (const event of client.subscribe()) { ... }
   *
   * The loop ends when the server closes the stream, and throws a QueueError if
   * the connection fails or an event can't be parsed. It does not reconnect, and
   * events sent while disconnected are lost, so call list() again after
   * reconnecting. Events can arrive slightly out of order, so treat each one as
   * "this job is now in this state", keyed by job id. Breaking out of the loop,
   * or aborting options.signal, closes the connection.
   */
  async *subscribe(options: SubscribeOptions = {}): AsyncGenerator<JobEvent, void> {
    const init: RequestInit = {
      method: "GET",
      headers: { "X-API-Key": this.apiKey, Accept: "text/event-stream" },
    };
    if (options.signal) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/events`, init);
    } catch (err) {
      if (options.signal?.aborted) return;
      throw new QueueError(`Could not reach the queue server at ${this.baseUrl}`, { cause: err });
    }
    if (!response.ok) {
      throw await errorFromResponse(response);
    }
    if (!response.body) {
      throw new QueueError("The server did not send an event stream", { status: response.status });
    }

    try {
      for await (const data of parseSSE(response.body)) {
        yield parseEvent(data);
      }
    } catch (err) {
      if (options.signal?.aborted) return; // the caller stopped it on purpose
      if (err instanceof QueueError) throw err;
      throw new QueueError("The event stream was interrupted", { cause: err });
    }
  }

  private async request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    what: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { "X-API-Key": this.apiKey };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.baseUrl + path, init);
    } catch (err) {
      throw new QueueError(`Could not reach the queue server at ${this.baseUrl}`, { cause: err });
    }

    if (!response.ok) {
      throw await errorFromResponse(response);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      throw new QueueError("The server sent a response that is not valid JSON", {
        status: response.status,
        cause: err,
      });
    }
    return parseWith(schema, data, what);
  }
}

/** Parses one event's data as JSON and checks it against the event schema. */
function parseEvent(data: string): JobEvent {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (err) {
    throw new QueueError("The server sent an event that is not valid JSON", { cause: err });
  }
  return parseWith(jobEventSchema, json, "event");
}

/** Builds a QueueError from a failed response, using the server's message when it sent one. */
async function errorFromResponse(response: Response): Promise<QueueError> {
  let message = `Request failed with HTTP ${response.status}`;
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    if (parsed.success) message = parsed.data.error;
  } catch {
    // The body wasn't JSON (a proxy's error page, for example), so keep the default message.
  }
  return new QueueError(message, { status: response.status });
}