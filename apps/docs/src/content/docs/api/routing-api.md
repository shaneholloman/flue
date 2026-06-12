---
title: Routing API
description: Compose Flue routes in an authored application entrypoint.
lastReviewedAt: 2026-06-02
---

Import application composition APIs from `@flue/runtime/routing`.

## `app.ts`

`app.ts` is an optional authored application entrypoint. Without it, Flue generates an application that mounts `flue()` at `/`. When `app.ts` exists, its default export owns the request pipeline and must mount `flue()` explicitly to publish Flue routes.

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();
app.route('/', flue());
export default app;
```

See [Routing](/docs/guide/routing/) for middleware, custom routes, prefixes, and application-owned dispatch.

#### `Fetchable`

```ts
interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

Structural contract for the default export of an authored `app.ts` entry. Any object exposing a compatible `fetch()` method satisfies it, including a `new Hono()` instance.

On Cloudflare, `env` contains bindings and `ctx` is the `ExecutionContext`. On Node, `env` contains Hono's Node adapter bindings for the incoming and outgoing messages, and `ctx` is `undefined`.

## `flue()`

```ts
function flue(): Hono;
```

Creates a mountable Hono sub-app for Flue's public HTTP API. Routes are relative to the application-chosen mount prefix.

| Route                      | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `GET /openapi.json`        | Return the public OpenAPI document.                                  |
| `POST /agents/:name/:id`   | Start a prompt on an HTTP-exposed agent instance; returns `202` with stream coordinates. |
| `GET /agents/:name/:id`    | Stream agent events via the Durable Streams protocol.                |
| `HEAD /agents/:name/:id`   | Return agent stream metadata (tail offset, closed status).           |
| `POST /workflows/:name`    | Start an HTTP-exposed workflow run.                                  |
| `GET /runs/:runId`         | Stream workflow-run events via the Durable Streams protocol.         |
| `GET /runs/:runId?meta`    | Retrieve the workflow-run record as plain JSON.                      |
| `HEAD /runs/:runId`        | Return run stream metadata (tail offset, closed status).             |

Agent and workflow invocation routes are available only when the corresponding module exports a `route` handler. Run routes inspect workflow runs only and are available beneath `flue()` after a run is admitted, regardless of whether that workflow exposes HTTP invocation. They may expose payloads, results, errors, and events. Applications publishing them should authorize access to the selected run. Direct agent prompts and dispatched agent inputs are not runs.

`POST /agents/:name/:id?wait=result` waits for the terminal result and returns `200 { result, streamUrl, offset }`. Without `?wait=result`, the same route returns `202 { streamUrl, offset }` after admission. `POST /workflows/:name?wait=result` similarly waits for the workflow result; without it, the route returns `202 { runId }`.

`GET /runs/:runId?meta` selects the run-record view of the run resource: the persisted record (`runId`, `workflowName`, `status`, timestamps, `payload`, `result`, `error`) as a plain JSON object. The `?meta` response carries no Durable Streams headers, and stream parameters (`offset`, `live`) are ignored on this view. Both views of `/runs/:runId` are guarded by the same workflow `route` middleware: if a caller can read the run's event stream, it can read the run record.

## Compose your own admin endpoints

Flue ships no admin HTTP surface. Build deployment-inspection endpoints from the server-side primitives exported by `@flue/runtime` — [`listRuns()`, `getRun()`, and `listAgents()`](/docs/api/data-persistence-api/#inspection-primitives) — behind your own authorization:

```ts title="src/app.ts"
import { listAgents, listRuns } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { requireOperator } from './auth.ts';

const app = new Hono();
app.route('/', flue());
app.use('/admin/*', requireOperator);
app.get('/admin/agents', async (c) => c.json(await listAgents()));
app.get('/admin/runs', async (c) => c.json(await listRuns({ limit: 100 })));
export default app;
```

The endpoints, their shapes, and their authorization are application-owned — add filters, pagination params, or projections as your operators need them.
