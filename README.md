\# Job Queue SDK



\[!\[CI](https://github.com/Mikkail04/Job-Queue-SDK/actions/workflows/ci.yml/badge.svg)](https://github.com/Mikkail04/Job-Queue-SDK/actions/workflows/ci.yml)



A typed TypeScript client for the \[Job Queue](https://github.com/Mikkail04/Job-Queue) HTTP API, written in Go. Enqueue jobs, read stats, retry dead jobs, and stream job events live.



\- \*\*Typed payloads:\*\* register a Zod schema per job type, and the compiler checks every `enqueue` call

\- \*\*Runtime validation:\*\* every server response is checked, so a bad response is a clear error

\- \*\*Live events:\*\* `subscribe()` is an async iterator over Server-Sent Events

\- \*\*One error type:\*\* `QueueError` covers network failures, HTTP errors, and bad responses



\## Usage



```ts

import { z } from "zod";

import { QueueClient, TypedQueueClient } from "@queue/sdk";



const client = new QueueClient({ baseUrl: "http://localhost:8080", apiKey: "dev-key" });

const typed = new TypedQueueClient(client, {

&#x20; "send-email": z.object({ to: z.email() }),

});



await typed.enqueue("send-email", { to: "a@b.com" }); // checked

await typed.enqueue("send-email", { to: 42 }); // compile error



const stats = await client.stats(); // { pending, running, succeeded, dead }

for (const job of await client.list({ status: "dead" })) await client.retry(job.id);



for await (const event of client.subscribe()) {

&#x20; console.log(event.type, event.job.id); // break to close the connection

}

```



\## Running it



```

pnpm install

pnpm typecheck

pnpm test

```



To also run the integration tests, start the Go server with `go run ./cmd/server -demo` (with `JOBQ\_API\_KEY` set), then set `QUEUE\_URL` and `QUEUE\_API\_KEY` before `pnpm test`. They are skipped otherwise.



\## Design notes



\- \*\*`fetch`, not `EventSource`:\*\* `EventSource` can't send an `X-API-Key` header, so the SDK parses the SSE stream itself.

\- \*\*Types follow the job type:\*\* checking `job.type` narrows `job.payload`.

\- \*\*Validate, don't trust:\*\* TypeScript types disappear at runtime, so Zod checks everything from the network.



\## Limitations



\- `subscribe()` doesn't reconnect, so call `list()` again after a disconnect.

\- No request timeouts or client-side retries.

\- Response types are written by hand and must be kept in sync with the Go API.

