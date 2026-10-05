\# Job Queue SDK



\[!\[CI](https://github.com/Mikkail04/Job-Queue-SDK/actions/workflows/ci.yml/badge.svg)](https://github.com/Mikkail04/Job-Queue-SDK/actions/workflows/ci.yml)



A TypeScript client for the HTTP API of my \[Go job queue](https://github.com/Mikkail04/Job-Queue). You can add jobs, check on them, retry the ones that failed for good, and watch jobs change state live.



I built it so mistakes get caught early. Each job type has a schema for its payload, so passing the wrong data won't compile. Every response from the server is checked at runtime too, so if the server sends something unexpected, you get a clear error instead of a mystery `undefined` later.



\## Example



```ts

import { z } from "zod";

import { QueueClient, TypedQueueClient } from "@queue/sdk";



const client = new QueueClient({ baseUrl: "http://localhost:8080", apiKey: "dev-key" });



// Tell the SDK what each job type's payload looks like.

const typed = new TypedQueueClient(client, {

&#x20; "send-email": z.object({ to: z.email() }),

});



await typed.enqueue("send-email", { to: "a@b.com" }); // fine

await typed.enqueue("send-email", { to: 42 }); // won't compile



// Check on things, and retry jobs that died.

const stats = await client.stats(); // { pending, running, succeeded, dead }

for (const job of await client.list({ status: "dead" })) {

&#x20; await client.retry(job.id);

}



// Watch jobs change state as it happens. Break out of the loop to disconnect.

for await (const event of client.subscribe()) {

&#x20; console.log(event.type, event.job.id);

}

```



\## Running it



```

pnpm install

pnpm typecheck

pnpm test

```



The tests that talk to a real server are skipped unless one is running. To include them, start the Go server with `go run ./cmd/server -demo` (after setting `JOBQ\_API\_KEY`), then set `QUEUE\_URL` and `QUEUE\_API\_KEY` in your terminal and run `pnpm test`.



\## Design choices



\- \*\*It uses `fetch` instead of `EventSource`.\*\* `EventSource` can't send custom headers, and the server needs an API key header, so the SDK reads the event stream itself.

\- \*\*Payload types follow the job type.\*\* Checking `job.type` tells TypeScript what `job.payload` looks like.

\- \*\*Zod checks everything that comes over the network.\*\* TypeScript's types don't exist at runtime, so they can't catch a bad response on their own.



\## Limitations



\- `subscribe()` doesn't reconnect. If the connection drops, call `list()` again to catch up.

\- The client has no request timeouts or automatic retries.

\- The response types are written by hand, so they have to be kept in sync with the Go API.

