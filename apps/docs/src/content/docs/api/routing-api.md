---
title: Routing API
description: Compose Flue routes in an authored application entrypoint.
lastReviewedAt: 2026-06-20
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

| Route                    | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `POST /agents/:name/:id` | Start a prompt on an HTTP-exposed agent instance; returns `202` with stream coordinates. |
| `GET /agents/:name/:id`  | Read materialized history or projected updates.                                          |
| `HEAD /agents/:name/:id` | Return canonical conversation-stream metadata.                                           |
| `POST /workflows/:name`  | Start an HTTP-exposed workflow run.                                                      |
| `GET /runs/:runId`       | Stream workflow-run events via the Durable Streams protocol.                             |
| `GET /runs/:runId?meta`  | Retrieve the workflow-run record as plain JSON.                                          |
| `HEAD /runs/:runId`      | Return run stream metadata (tail offset, closed status).                                 |
| `* /channels/:name/*`    | Serve method- and suffix-specific discovered channel handlers.                           |

Agent routes and workflow invocation routes are available only when the corresponding module exports `route`. A workflow's existing run resources are available only when its module separately exports `runs`. Discovered channel files export a named `channel` binding whose provider-declared routes are always mounted beneath `/channels/<filename>`. Direct agent prompts and dispatched agent inputs are not runs.

`POST /agents/:name/:id` accepts a JSON body of `{ message, images? }`: a required `message` string and an optional `images` array of `{ type: 'image', data, mimeType }` attachments, where `data` is base64-encoded image content (capped at 14 MiB of base64 characters per image) for vision-capable models. `POST /workflows/:name` accepts the workflow input as its JSON body.

`POST /agents/:name/:id` returns `202 { streamUrl, offset, submissionId }` after admission, or `200 { result, streamUrl, offset, submissionId }` with `?wait=result`; agent response headers and stream-coordinate behavior are unchanged. `POST /workflows/:name` returns `202 { runId }`, or `200 { runId, result }` with `?wait=result`. Workflow invocation responses do not include `Location` or `Stream-Next-Offset` headers. Any `?wait` value other than `result` is rejected with `400 invalid_request` on both routes.

For agent prompts, waiting with `?wait=result` is best-effort and scoped to the process that admitted the prompt. The prompt itself is a durable submission either way: if the admitting process is interrupted before settlement, the waiting connection is lost while recovery settles the submission in the background — the outcome then appears in canonical conversation history and as a `submission_settled` record on the agent's stream instead of answering the original request. A caller that must observe the outcome across interruptions should read the agent stream from the returned coordinates rather than relying on the synchronous response.

`GET /runs/:runId?meta` selects the persisted run-record view (`runId`, `workflowName`, `status`, timestamps, `input`, `result`, `error`) as plain JSON. The `?meta` response carries no Durable Streams headers, and stream parameters (`offset`, `live`) are ignored.

For an existing run, Flue invokes its owning workflow's `runs` middleware with an ordinary Hono context before handling `GET`, `HEAD`, `?meta`, unsupported methods, or future run methods. Middleware may deny the request or call `next()`. If the workflow has no `runs` export, Flue returns a generic `404` indistinguishable from an unknown or removed run. Unsupported methods become `405` only after the run is exposed and authorized.

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
