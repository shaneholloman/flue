# Flue Observability & Event-Streaming Plan

**Status:** Design complete. Ready to execute after the terminology cleanup lands in the codebase.
Use this as the north star, not a script.

Terminology note: this plan predates the explicit Harness layer. Where this document says AgentInstance, it means the URL `<id>` scope exposed as `ctx.id`. A run may initialize one or more named harnesses (`init({ name })`, default `"default"`), and events should carry enough correlation data to distinguish harnesses inside the same run.

## How to Use This Document

This plan describes the **shape and intent** of adding structured event logging, durable run history, and reconnectable streaming to Flue. It is deliberately not a step-by-step recipe.

Treat the **goals, decisions, and constraints** as load-bearing. Treat the **suggested file layout, code sketches, and step ordering** as starting points that should bend to reality as you learn.

If you discover something that conflicts with what's written here, prefer the discovery — but explain why in the implementation, ideally as an appended Deviation entry at the bottom of this file. The goal is a working observability system that delivers the architecture, not a literal implementation of these words.

When in doubt, the project owner (Felix) is available; ask rather than guess on architectural decisions.

### The single most important thing

**Events are the source of truth, and they are wide where it matters.** Every meaningful boundary in a run (operation completes, tool finishes, run ends) emits one event carrying everything a consumer would want to know — duration, usage, args, result, error, parent IDs. Narrow streaming events (text/thinking deltas, tool-call started) stay for live-UI value, but the canonical record of "what happened" is the wide lifecycle event.

There is **no separate Span abstraction**. Correlation IDs (`runId`, `sessionId`, `operationId`, `taskId`, `toolCallId`, `parentSessionId`) form an implicit tree. A future OTel exporter, if we ever build one, translates each wide event into one span trivially.

This framing matters because it kills a recurring temptation: "we should add spans alongside events." Don't. The events ARE the spans. Treating them as one thing keeps the wire protocol and the operator-facing observability surface in lockstep, and means we ship one abstraction instead of two.

### Working style

The project owner has asked for **review at meaningful checkpoints** (the phases below). That doesn't mean blocking on every micro-decision — use judgment for routine implementation choices. It does mean: surface architectural surprises, finish a phase cleanly before starting the next, demonstrate working behavior at each milestone before moving on.

Each phase is independently shippable. Pause between phases is fine; reorder if reality demands.

**Feedback doc workflow:** every time you hit a Flue/pi-agent-core/Cloudflare rough edge that would benefit upstream attention, write a short markdown doc in `docs/proposals/<topic>.md` immediately, in the same commit that captures the workaround in code. Continuous, not batched. By the end of the plan you have a folder of proposals ready to share without a "compile feedback" hand-wave.

## Context

### What Flue is today

Flue agents are TypeScript handler functions deployed as HTTP servers (Node or Cloudflare Workers). A caller POSTs to `/agents/<name>/<id>`; the handler initializes one or more harnesses via `init()`, then runs LLM calls via `session.prompt()` / `session.skill()` / `session.task()` / `session.shell()`; the handler returns a value that becomes the HTTP response. The harness emits an in-process `FlueEvent` stream (`text_delta`, `tool_start`, `tool_end`, `idle`, etc.) consumed by a single per-request callback (`ctx.setEventCallback`, `packages/sdk/src/client.ts:116`).

Three request modes exist today (`packages/sdk/src/runtime/handle-agent.ts:102`):
- **Sync** (`Accept: application/json`): handler runs, returns JSON. The default mode.
- **SSE** (`Accept: text/event-stream`): handler runs, events stream to the caller, terminal `event: result` carries the return value.
- **Webhook** (`X-Webhook: true`): 202 Accepted, handler runs in background, no observability after the ack.

The SSE pipe is the existing seam everything below builds on. It already writes monotonic `id:` fields but never reads `Last-Event-ID` on reconnect, has no durability, and offers no history endpoint. Webhook mode mints a `requestId` (`handle-agent.ts:178`) that nothing keys off later.

### What we're adding

Concretely:

- **Promote runs to first-class addressable entities.** Every HTTP invocation gets a server-minted `run_<ulid>` regardless of mode. URLs gain `/runs`, `/runs/<runId>`, `/runs/<runId>/stream`, `/runs/<runId>/events`.
- **Persist events.** Cloudflare: per-instance DO SQLite log. Node: per-instance in-memory ring buffer.
- **Reconnect via standard `Last-Event-ID`.** Replay-then-tail with no caller-side dedup.
- **Wide lifecycle events with full payloads.** `operation` (renamed/upgraded `operation_end`), `tool_call` (renamed `tool_end`), `run_end` carry duration, usage, args, results, errors. Narrow `*_start` and `*_delta` events stay for live UIs.
- **Explicit `ctx.log` API.** First-class structured logging from handler code that flows into the event stream as `log` events.
- **Unify return-value delivery across modes.** Sync mode becomes a server-side wrapper around the event stream that waits for terminal `run_end` and returns its payload. Errors unify: `run_end { isError: true, error }` translates back to a non-2xx HTTP response.

### What we're not adding (in v1)

Bidirectional caller input (no `user.interrupt`, no `user.message`, no tool confirmation). Observe-only. A run is driven entirely by the handler from start to finish; callers watch.

This is a deliberate v1 scope cut. The plumbing for interrupt exists internally (`AbortSignal` in `runOperation`, `session.ts:1039`), but the handler model isn't prepared for "external input arrives mid-run" semantics. Punting until there's a real use case and a thought-through handler API.

## Goals

When this plan is done:

- Every HTTP invocation of an agent has a server-minted `runId` returned to the caller (in the response for sync, as the first event for SSE).
- A caller can `GET /agents/<name>/<id>/runs/<runId>/stream` with `Last-Event-ID: <n>` and receive all events emitted after `n`, then tail live events to the run's terminal `run_end`.
- A caller can `GET /agents/<name>/<id>/runs` to list recent runs on an instance, with status (`active` / `completed` / `errored`).
- Handler code can call `ctx.log.info(...)` / `.warn(...)` / `.error(...)` and have those structured log lines flow into the event stream as `log` events visible to callers and persisted in run history.
- The wide lifecycle events (`operation`, `tool_call`, `run_end`) carry duration, token usage (where applicable), errors, and parent correlation IDs sufficient to reconstruct a run's tree.
- The Cloudflare target persists per-instance run history (last N runs, configurable, default 50) in DO SQLite. Reconnection works across DO hibernation.
- The Node target persists per-instance run history in an in-memory ring buffer of the same shape. Restart loses it — documented limitation.
- `flue logs <agent> <id> [runId]` streams events from an in-progress or recently-completed run. Without `runId`, defaults to the most recent run.
- `flue run` prints the `runId` on stdout (or stderr) so it can be handed off to `flue logs --resume`.
- All checks green: `pnpm run check:types` across packages, `pnpm test`, existing examples (`examples/hello-world`, `examples/cloudflare`) work unchanged.

## Out of scope

- **Bidirectional caller input.** No `POST /runs/<runId>/events` endpoint, no interrupt, no mid-run message, no tool confirmation. Plumbing exists internally; surfacing it deserves its own design pass with handler-API implications.
- **A first-party caller SDK** (`@flue/client`). The wire protocol is the contract; users wire to it with native `fetch` + `EventSource` until a proper client SDK lands as a separate effort.
- **OpenTelemetry export.** Not a goal. The wide-events design happens to make an OTel exporter trivial later, but no semconv work, no `@opentelemetry/*` dependencies, no spans-as-first-class-objects.
- **Production telemetry backends.** No Datadog/Honeycomb/Sentry integration. The events are queryable via Flue's own endpoints; users who want to forward to an external sink build that themselves on top of the event log.
- **Node durability beyond in-memory.** A bring-your-own-persistence interface (`EventStore` analog to `SessionStore`) is the natural extension and is a Phase 2 concern. Node users who restart their server lose run history.
- **Sampling, log levels beyond info/warn/error, or redaction policies.** Sensitive-data handling is the caller's responsibility today; if a tool result contains a secret, it'll appear in the event log. The existing `redactEnvValues` (`session.ts:1594`) for shell-injected env values stays as-is; nothing new added.
- **Instance-level admin endpoints** (`GET /agents/<name>/<id>` for state, dashboards, fleet views). The "what's running right now?" use case is met by `GET /runs?status=active`. Anything richer is admin-dashboard territory and out of scope.
- **Per-stream auth, signed URLs, or browser `EventSource` compatibility.** API-key auth, same as today. Browsers proxy through a server. No `?token=` query param shenanigans.
- **Multi-modal in event payloads.** If a handler returns an image, today it's a base64 string in JSON; same in `run_end.result`. No special handling.

## Decisions

The decisions below are load-bearing — they constrain how subsequent phases must shape themselves. Numbered for reference in Deviations entries.

### 1. Hierarchy: Agent → AgentInstance → Run → Harness → Session → Operation → Turn

Five named layers, each with a clear reason to exist:

```
Agent (definition)        — the code in agents/<name>.ts
└─ AgentInstance          — keyed by the URL <id> path segment; exposed as ctx.id
   └─ Run (run_<ulid>)    — one HTTP invocation of the handler
      └─ Harness          — one init({ name }) call; defaults to "default"
         └─ Session       — harness.session(name?); defaults to "default"
            └─ Operation (op_<ulid>) — one session.prompt/skill/task/shell call
               └─ Turn    — one LLM round-trip (internal to pi-agent-core, not surfaced)
```

This terminology cleanup is **assumed already complete** by the time this plan executes. It is not part of this plan's scope. Where this plan refers to "instance" it means the entity keyed by `<id>` and exposed as `ctx.id`; where it refers to "run" it means the entity minted at HTTP entry.

A run is **bounded by the handler's invocation.** It starts when the HTTP request arrives, it ends when the handler returns (or throws). Between runs on the same instance, the session can persist (via `SessionStore`), but no events flow.

### 2. Wide lifecycle events; narrow streaming events

Two flavors:

- **Wide lifecycle events** (`tool_call`, `task`, `compaction`, `turn`, `operation`, `run_end`): emitted once at the end of the thing, carrying everything a consumer might want — durations, usage, args, result, error, parent IDs. These are the canonical record of "what happened" — they're what a future OTel exporter or a Honeycomb-style query would consume.
- **Narrow streaming events** (`text_delta`, `thinking_*`, `tool_start`, `task_start`, `compaction_start`, `operation_start`, `run_start`, `idle`, `log`): emitted continuously during work for live UIs. They are still replayed on reconnect (we don't drop them in storage), but they're not the analytical primitive.

**Naming convention.** A completed-thing event is named for the thing, not the boundary: `tool_call`, `task`, `compaction`, `turn`, `operation`, `run_end`. The exception is `run_end` — `run` alone would be confusing because the *run* itself has been the addressed-by-runId entity throughout the doc, and `run_end` reads more clearly as "the final event of the run." The pattern is otherwise consistent.

Concretely, the existing event vocabulary evolves like this:

| Existing | Becomes | Notes |
|---|---|---|
| `agent_start` | **removed** | redundant with `operation_start` once that lands; pi-agent-core's `agent_start` fires per-prompt, which is per-operation |
| `text_delta`, `thinking_*` | unchanged | narrow, live-only value |
| `tool_start` | unchanged | progress indicator |
| `tool_end` | **`tool_call` (wide)** | adds `durationMs`, keeps everything it has |
| `turn_end` | **`turn` (wide)** | adds `usage` (input/output/cache_read tokens), `durationMs`, model id |
| `task_end` | **`task` (wide)** | adds `durationMs`, keeps existing fields |
| `task_start` | unchanged | narrow start signal |
| `compaction_end` | **`compaction` (wide)** | adds `durationMs` |
| `compaction_start` | unchanged | narrow start signal |
| `idle` | unchanged | end-of-operation marker (kept as a distinct signal from `operation`; see below) |
| (new) | **`operation_start`** | narrow; emitted at `runOperation` entry |
| (new) | **`operation` (wide)** | emitted at `runOperation` exit; carries `operationKind`, `durationMs`, `usage` aggregate, `result` if applicable, `isError`, `error` |
| (new) | **`run_start`** | narrow; first event of every run |
| (new) | **`run_end` (wide)** | terminal event of every run; carries `result`, `isError`, `error`, `durationMs`, aggregate `usage` |
| (new) | **`log`** | narrow; emitted by `ctx.log.{info,warn,error}` calls in handler code |

`idle` is kept alongside `operation` because the existing runtime contract (`session.ts:1071`, `handle-agent.ts:285`) keys off `idle` as the "everything quiet" signal between operations. It's the boundary marker; `operation` is the analytical record. Both fire at the same moment in `runOperation`'s finally block; the rename would cascade through the existing exclusive-lock and SSE-mode-end logic without a clear win. Worth revisiting in a future pass.

Renames are breaking. All event-consuming code in the repo (CLI at `packages/cli/bin/flue.ts:485`, internal listeners) updates in the same commit as the rename. See decision 15.

### 3. Correlation IDs form the implicit tree

Every event carries enough IDs to reconstruct the tree post-hoc:

- `runId` (always)
- `harnessName` (events emitted from harness sessions)
- `sessionId` (most events; tasks carry their own)
- `parentSessionId` (set on events from task sub-sessions)
- `taskId` (set on task-sub-session events)
- `operationId` (set on events emitted during an operation)
- `toolCallId` (set on tool events)
- `eventIndex: number` (monotonic per-run; the `id:` SSE field)
- `timestamp: string` (ISO 8601)

Today some of these exist (`sessionId`, `parentSessionId`, `taskId`, `toolCallId`); `runId`, `harnessName`, `operationId`, `eventIndex`, `timestamp` are new or newly formalized. The new ones are minted or attached server-side at the obvious boundaries:

- `runId` at `handleAgentRequest` entry (`packages/sdk/src/runtime/handle-agent.ts:102`) before mode branches.
- `harnessName` at the harness event-decorator layer.
- `operationId` inside `Session.runOperation` (`session.ts:1039`), threaded through `setEventCallback` decoration like `parentSessionId`/`taskId` already are.
- `eventIndex` incremented per-event in the event-emit funnel.
- `timestamp` stamped at emit time.

No separate "trace context" propagation mechanism. No `AsyncLocalStorage` for tracing. The single in-process `setEventCallback` seam stays the funnel; we just decorate more.

### 4. runId is server-minted ULID

Server-side at HTTP entry. ULID over UUID because they sort by time, which is genuinely useful for "list recent runs ordered by recency" without a separate `createdAt` index. The existing webhook `crypto.randomUUID()` (`handle-agent.ts:365`) is replaced.

Returned to the caller:
- **SSE**: as the first event (`run_start { runId, instanceId, agentName, startedAt, payload }`) AND in an `X-Flue-Run-Id` response header.
- **Sync**: in an `X-Flue-Run-Id` response header AND in a `_meta: { runId }` field on the JSON response (alongside `result`). Backward-compat: existing callers reading `result` directly still work; new callers can pick up the `runId` from either place.
- **Webhook**: in the existing 202 body (replaces the current `requestId` field — same shape, new name).

No client-supplied run IDs. No idempotency story. Defer.

### 5. Last-Event-ID is the reconnect mechanism

Standard SSE behavior. Server reads the `Last-Event-ID` request header on `GET /runs/<runId>/stream`. If absent, stream from the start of the run's event log. If present, replay events strictly after that index, then tail live. The `id:` field on each SSE frame is the per-run monotonic `eventIndex`.

Replay is **complete**: every persisted event after the cursor, including narrow streaming events, is replayed. We don't try to be clever and skip text_deltas on reconnect — clients that don't care about them filter client-side. This keeps the server simple and the replay deterministic.

If the run has already terminated when the client connects/reconnects, the server replays the full log (or the suffix after `Last-Event-ID`) including the terminal `run_end`, then closes the stream. No special-casing of "stream a finished run."

### 6. Per-instance persistence; ring-buffered by count

Run records are persisted per AgentInstance — same scoping as `SessionStore` today. On Cloudflare, the DO that already owns the instance's sessions also owns its run history (same SQLite database, sibling tables). On Node, an in-memory data structure lives alongside the harness/session runtime objects for the process.

Two tables conceptually (on CF, two real SQLite tables; on Node, two `Map`s):

- **runs**: `(runId, instanceId, agentName, status, startedAt, endedAt, isError, durationMs)` — one row per run, indexed by `(instanceId, startedAt DESC)` for listing.
- **events**: `(runId, eventIndex, type, payload, timestamp)` — events for each run, indexed by `(runId, eventIndex ASC)` for replay.

**Retention is bounded by count, not time.** Default: last 50 completed runs per instance, all active runs always kept. When a 51st run completes, the oldest completed run is deleted (cascading its events). Configurable via `app.ts` (`createFlueApp({ runHistory: { maxCompletedRuns: 50 } })`) but ship the default; users tune only if storage pressure surfaces.

**Trivial implementation first.** On CF, "delete oldest" can be a `DELETE FROM runs WHERE runId IN (SELECT runId FROM runs WHERE instanceId = ? AND status != 'active' ORDER BY startedAt ASC LIMIT ?)` run after every run completion. Don't optimize prematurely; SQLite handles small workloads fine.

### 7. Node persistence is in-memory only; bring-your-own is Phase 2

Node target uses an in-memory `Map<runId, RunRecord>` and `Map<runId, FlueEvent[]>` on the process. Restart loses everything. **Document loudly** in the Node target docs that production deployments wanting durable run history should choose Cloudflare or wait for the BYO persistence interface.

The shape of the in-memory store is **structurally identical** to the SQLite store so the bring-your-own interface can land later without protocol changes — the persistence layer is just a `RunStore` interface with `appendEvent(runId, event)`, `getEvents(runId, fromIndex?)`, `createRun(...)`, `endRun(...)`, `listRuns(instanceId, filter)`, `getRun(runId)`. Two implementations ship in v1; users provide a third via `createFlueApp({ runStore: customStore })` in Phase 2.

### 8. Run is HTTP-invocation-bounded; terminal `run_end` carries the result

The run ends when the handler returns (or throws). The runtime emits `run_end { result, isError, error?, durationMs, usage? }` as the final event in every run, then closes the stream.

**Sync HTTP mode is a server-side wrapper around the same stream.** Internally, sync-mode handling consumes its own event stream and returns `run_end.result` as the JSON body (or translates `isError: true` into a non-2xx HTTP response with the error body). One code path, two surfaces. The existing `runSyncMode` / `runSseMode` / `runWebhookMode` branching at `handle-agent.ts:113` collapses into mode-specific output formatting on top of a shared event-producing core.

**Errors unify.** Today `runSyncMode` returns 4xx/5xx with a `FlueError` envelope, `runSseMode` emits `event: error`, `runWebhookMode` ack returns 202 regardless. After this lands: every run emits `run_end` with `isError: true` and a structured `error` payload; mode-specific wrappers translate to HTTP status codes for sync, to a final SSE frame for stream, to nothing for webhook (the run completion is observable via `GET /runs/<runId>`).

### 9. URL design: run-scoped resources

```
POST   /agents/<name>/<id>                      Start a run (unchanged signature)
                                                Returns X-Flue-Run-Id header in all modes
GET    /agents/<name>/<id>/runs                 List runs on this instance
                                                Query: ?status=active|completed|errored
                                                       ?limit=<n> (default 20, max 100)
                                                       ?before=<runId> (pagination cursor)
GET    /agents/<name>/<id>/runs/<runId>         Run summary: { runId, status, startedAt,
                                                  endedAt?, result?, isError?, error?,
                                                  durationMs?, usage? }
GET    /agents/<name>/<id>/runs/<runId>/stream  SSE tail. Honors Last-Event-ID.
                                                If run terminal, replays full log + closes.
GET    /agents/<name>/<id>/runs/<runId>/events  JSON list of events
                                                Query: ?after=<eventIndex>
                                                       ?types=<comma-separated>
                                                       ?limit=<n> (default 100, max 1000)
```

404 on any path referencing a nonexistent run. No POST endpoints for events (no bidirectional in v1).

These mount under the existing `flue()` Hono sub-app (`packages/sdk/src/runtime/flue-app.ts:125`). The per-target context factory dispatches them the same way the existing `/agents/<name>/<id>` route does — Node in-process, CF routes to the DO via the `agents` SDK's `routeAgentRequest`.

### 10. Logging: explicit `ctx.log` API, no console interception

Handler code calls:

```ts
ctx.log.info('processing case', { caseNumber, taxonomy: taxonomy.length });
ctx.log.warn('fallback model used', { reason: 'rate_limit' });
ctx.log.error('SF fetch failed', { error: e });
```

These emit `log` events into the stream:

```ts
{ type: 'log', level: 'info' | 'warn' | 'error', message: string,
  attributes?: Record<string, unknown>, timestamp, ... correlation IDs }
```

The user explicitly chooses what becomes caller-visible. No `console.log` interception. `console.log` from handler code or custom tool bodies continues to go to server stderr exactly as it does today and is **not** part of the event stream. Users who want their logs visible to callers migrate to `ctx.log`.

Custom tool bodies have access to the same logger via a passed-in `context` parameter (or via `ctx.log` if the tool was defined inside the handler's closure — most are). Built-in tools (`read`, `write`, `bash`, etc.) don't emit `log` events; they emit `tool_call` events as today.

Cross-cutting Flue diagnostics (`[flue:compaction]` chatter at `session.ts:1222`+) get a structured migration: those `console.error` sites become `internalLog` calls that go to server stderr AND emit `log` events at `info` level. Users see them in the stream; operators see them in worker logs.

### 11. The wire is the contract; no first-party caller SDK in v1

Callers wire to the HTTP+SSE protocol directly with native `fetch` + `EventSource` (or equivalent). The CLI (`flue logs`, see decision 13) is the in-tree reference consumer. A proper `@flue/client` package is out of scope; it'll come as a separate effort once the wire stabilizes.

This is a deliberate scope cut. Designing the client surface (auth, retries, reconnect helpers, typed event narrowing) is a meaningful sub-project; doing it concurrently with the server work risks coupling the wire protocol to a particular client ergonomic. Ship the protocol; let consumers (including the CLI) drive what the client surface should look like; build the client after.

### 12. Event payload size limits

A tool that reads a 10MB file produces a `tool_call` event with a 10MB result. Persisting and replaying that on every reconnect is bad.

**Soft limit at the persistence boundary.** Events larger than 256KB serialized are stored truncated: the full event payload is replaced with `{ truncated: true, originalSize: N, preview: <first 1KB> }` for fields like `result`, `args`, `text` — selectively, not the whole event. The narrow streaming variants (`text_delta`) are never truncated; they're already chunked.

Tunable per-instance via `app.ts` (`runHistory: { maxEventBytes: 262144 }`). Truncation is logged via `internalLog`. The live SSE stream sends the full event (truncation only affects persistence + replay) so first-time consumers see everything.

This keeps DO SQLite within reasonable per-row limits and keeps reconnect-replay bounded. The OpenAI Agents SDK does something similar at their ingest boundary; the technique is sound.

### 13. CLI surfaces: `flue run` prints runId; `flue logs` connects

Two CLI changes:

1. **`flue run` prints `runId` to stderr** before streaming begins (`flue run hello foo --id abc`). Format:
   ```
   [flue] run started: run_01HX...
   ```
   This is stderr because stdout is reserved for the final `result` JSON. Users can `tee` stderr to capture the runId.

2. **`flue logs <name> <id> [runId]`**: new command. Streams events from a run.
   - With `<runId>`: connects to that run's stream endpoint. Uses `Last-Event-ID` if reconnecting (state held in-memory; no cross-invocation persistence in v1).
   - Without `<runId>`: fetches `GET /runs?limit=1` and connects to the most recent run.
   - `--follow`: if the run is terminal, exits after replaying. If active, tails. `--follow` keeps tailing across terminal `run_end` and waits for new runs on the same instance (Phase 2; v1 just exits after `run_end`).
   - `--since <eventIndex>`: explicit Last-Event-ID for resume.
   - `--types <comma-separated>`: filter client-side (don't print events of other types).

`flue run` and `flue logs` share a common SSE consumer (refactor `consumeSSE` at `packages/cli/bin/flue.ts:604` into a reusable function).

### 14. Build artifact size

The new event-handling code paths add bytes to the worker bundle. Target: total worker bundle size under +50KB (gzipped) vs. today. Most of the new code is on the SDK side (event funnel, persistence interface, route handlers); the per-agent generated entry (`build-plugin-cloudflare.ts:49`) gains only a handful of lines for the new routes.

If the bundle grows beyond budget, the persistence implementations are the natural extraction point — they could move to a separate import path that's only pulled in when run history is enabled (config-gated). Don't preempt this; measure and split if needed.

### 15. This is a breaking release; document the breaks, don't soften them

Flue is pre-1.0 and the project owner has explicitly opted out of back-compat work. Renames happen in one shot. There is no deprecation cycle, no aliasing of old event types, no transitional `_meta` placement that pretends nothing moved. The changelog lists every break; consumers update.

The known breaks landing as part of this plan:

- `FlueEvent.tool_end` renamed to `tool_call` (wide). Renamed in the same commit that adds `durationMs`.
- `FlueEvent.task_end` renamed to `task` (wide); `compaction_end` renamed to `compaction` (wide). Same convention as `tool_call`: a completed-thing event is named for the thing, not the boundary. See decision 2's table.
- `agent_start` removed (redundant with `operation_start` once that lands; decision 2).
- Sync HTTP response body adds `_meta: { runId }` alongside `result`. Consumers that destructure the whole body shape need to ignore the new field; consumers that read `result` are fine.
- Webhook 202 body field renamed `requestId` → `runId`. Same shape, new name.
- SSE wire adds `run_start` / `run_end` / `operation_start` / `operation` / `log` events. Consumers must accept-or-ignore unknown event types — anything that hard-rejects unknowns breaks. The in-tree CLI consumer is the migration test case.

The in-process additions (`ctx.log`, `ctx.runId`) are net-new and don't break anything.

### 16. Internal event funnel becomes a fan-out from Phase 1

`ctx.setEventCallback` is single-slot today (`client.ts:116`). The persistence layer (Phase 1) and the run-stream endpoint's live subscription (Phase 4) are both subscribers, and we need both at the same time — the SSE writer for the active request, the persistence store appending to the log, the run-stream endpoint forwarding to a separate observer. Single-slot can't carry all three.

The runtime grows an internal `subscribe(handler) → unsubscribe()` fan-out at the same `client.ts:116` seam. Land it in Phase 1 alongside the persistence wiring rather than as a Phase 4 refactor — Phase 1's "wire the store into the event funnel" *is* the first second-subscriber.

**The public handler-facing API does not change.** Handlers continue to use `ctx.setEventCallback`, which under the hood subscribes and replaces any previous handler-installed callback. The fan-out is internal: persistence + handler-callback + (later) endpoint-observer all subscribe independently.

### 17. Webhook mode does not gain async callbacks

"Webhook" is a name carried forward from today's implementation but it's a misnomer in the rest-of-the-world sense: today's webhook mode is fire-and-forget background execution, not "you give us a URL and we POST to it when done." Nothing in this plan changes that. Webhook mode in this plan:

- Returns 202 immediately with `{ runId }` in the body (renamed from `requestId`; decision 15).
- Runs the handler to completion in the background (in-process on Node, in the DO fiber on CF).
- Persists events the same way sync and SSE modes do.
- Callers poll `GET /runs/<runId>` or open `GET /runs/<runId>/stream` to discover completion.

This matters because readers familiar with "webhooks" elsewhere will expect HTTP-callback semantics, and we don't deliver that. Document explicitly: webhook mode means "kick off async; observe via the run-scoped endpoints." If real callback-on-completion is needed later, that's a separate feature ("notifications"? "callbacks"?) and a separate design pass.

## Phases

The plan executes in 5 phases on a single feature branch (or one branch per phase, at the implementer's discretion). Each phase is independently mergeable and shippable; we can pause indefinitely between any two.

End-to-end validation at every phase: existing examples (`examples/hello-world`, `examples/cloudflare`) continue to work; the new behavior is verified via `flue run` + `flue logs` against the same examples.

### Pre-flight checklist

Before starting Phase 1, confirm:

- **Terminology cleanup complete.** Agent → AgentInstance → Run → Harness → Session → Operation → Turn naming exists in the codebase. URL `<id>` is understood as the agent instance id (`ctx.id`), and `init()` returns a named harness.
- **ULID dependency choice.** Pick a ULID library or roll our own (~30 lines). Doesn't need to be cryptographically strong — server-trusted only. Confirm cross-target compatibility (Node + workerd).
- **DO SQLite schema migration story.** Existing CF deployments have `flue_sessions` table. The new `flue_runs` and `flue_events` tables need to be created on the first request after deploy. Use the `agents` SDK's migration hooks if available; else inline `CREATE TABLE IF NOT EXISTS` in the DO startup path.
- **CLI test fixtures.** A way to run `flue run` and `flue logs` against a local `flue dev` server without an `ANTHROPIC_API_KEY` (use a mock provider or a no-LLM "hello" agent).
- **Project owner availability.** Felix is reachable for architectural questions during execution.

### Phase 1 — Runs as first-class entities; persistence; `run_start`/`run_end`

Promote `runId` to a per-request first-class concept. Establish the persistence interface and both target implementations. Land the `subscribe`-style internal event fan-out (decision 16). Add the two run-bracketing events (`run_start`, `run_end`) so the persisted log shape is forward-compatible with Phase 2's broader vocab work.

**Goal:** at the end of Phase 1, every request has a `runId`, every event (including new `run_start`/`run_end`) is being persisted under that `runId`, and the internal callback seam is multi-subscriber. No new HTTP endpoints yet; no other event vocab changes yet.

Concrete work:

- **Mint `runId` at `handleAgentRequest` entry.** ULID. Add to all three modes (sync, SSE, webhook). Replace `requestId` minting in `runWebhookMode` with `runId`. Expose as `ctx.runId` on `FlueContext`.
- **Convert `ctx.setEventCallback` to a fan-out `subscribe`** (decision 16). The public handler API (`setEventCallback`) stays as-is for back-compat with handlers, but internally it routes through a list. Persistence and the SSE writer both subscribe independently.
- **Thread `runId` into events.** Decorate the event-emit funnel similarly to how `parentSessionId`/`taskId` are decorated in `harness.ts`. Every event gains `runId` + `eventIndex` + `timestamp`.
- **Add `run_start` and `run_end` events.** Emit at `handleAgentRequest` entry and exit (after the handler returns or throws). `run_start { runId, instanceId, agentName, startedAt, payload }`. `run_end { result, isError, error?, durationMs }`. The existing SSE `event: result` continues to fire alongside `run_end` for in-flight back-compat through Phase 2; remove `event: result` when Phase 2's broader vocab changes land.
- **Define the `RunStore` interface.** Single-file: `packages/sdk/src/runtime/run-store.ts`. Methods: `createRun`, `endRun`, `appendEvent`, `getEvents`, `listRuns`, `getRun`. Type-only; no implementation here.
- **Implement `InMemoryRunStore` for Node.** `packages/sdk/src/node/run-store.ts`. Two `Map`s scoped per AgentInstance. Per-instance ring buffer of completed runs (default 50).
- **Implement `DurableRunStore` for Cloudflare.** `packages/sdk/src/cloudflare/run-store.ts`. Uses the DO's SQLite store (`build-plugin-cloudflare.ts:220` is the existing precedent). Two tables (`flue_runs`, `flue_run_events`). Indexes on `(instanceId, startedAt DESC)` and `(runId, eventIndex ASC)`.
- **Wire the store as a subscriber on the fan-out.** Best-effort: persistence errors are logged (via the future `internalLog`; for now via `console.error` with `[flue:run-store]` prefix) but don't fail the request.
- **Return `runId` in responses.** Sync: `_meta.runId` + `X-Flue-Run-Id` header. SSE: in the `run_start` event body and the `X-Flue-Run-Id` header. Webhook: rename `requestId` → `runId` in the 202 body.
- **Apply the 256KB truncation policy at the persistence boundary** (decision 12). Truncation logic in the store layer, not at emit time.

**Definition of done:** Every request produces a `runId` visible in the response. Every event (including `run_start`/`run_end`) is persisted under that runId, queryable via direct store inspection in tests. Internal `subscribe` fan-out supports multiple concurrent subscribers without stomping. Existing CLI consumer (`flue run`) still works unchanged — it sees the new `run_start`/`run_end` events but treats them as unknown and ignores them; the legacy `event: result` is still emitted so the existing terminal-event handling works. Both targets pass typecheck. No new HTTP endpoints yet.

### Phase 2 — Wide-events restructuring; ctx.log; sync-mode unification

Land the rest of the wide-events vocab changes from decision 2 and the structured logging API. The persisted-event shape changes here; runs created before this lands have the Phase 1 shape (with `tool_end` etc. and a separate legacy `event: result`). We do **not** migrate old data — the ring-buffered retention will age it out within ~50 runs. Document this.

Concrete work:

- **Rename `tool_end` → `tool_call`** (wide) in `FlueEvent` (`packages/sdk/src/types.ts:647`), `Session` translation layer (`session.ts:487-503`), and CLI consumer (`packages/cli/bin/flue.ts:485`). Add `durationMs` field, populated using the `tool_start` timestamp.
- **Rename `task_end` → `task` (wide)** and **`compaction_end` → `compaction` (wide)**. Same convention as `tool_call`. Add `durationMs` to both.
- **Rename `turn_end` → `turn` (wide).** Add `usage` (input/output/cache_read tokens, surfaced from `harness.subscribe`), `durationMs`, and `model` id.
- **Remove `agent_start`.** Redundant with `operation_start` once that's in place. The Session translation layer at `session.ts:469` drops the corresponding case.
- **Add `operation_start` and `operation` events.** Emit at the entry and exit of `Session.runOperation` (`session.ts:1039`). The wide `operation` carries `operationKind` (one of `'prompt' | 'skill' | 'task' | 'shell'`), `durationMs`, aggregate `usage` over the operation, and `result`/`isError`/`error`. Thread `operationId` (ULID) through the event-decoration layer.
- **Remove the legacy SSE `event: result` framing.** Replaced by `run_end`. The CLI consumer's terminal-event handling switches from `event: result` to `run_end`.
- **Define `ctx.log`.** Add `log: { info, warn, error }` to `FlueContext` (`types.ts`). Implement in `createFlueContext` (`client.ts:44`). Each call emits a `log` event with `level`, `message`, `attributes`, and the current correlation IDs.
- **Migrate internal diagnostics** (`[flue:compaction]` etc.) to a sibling `internalLog` helper that does both: `console.error` AND emit a `log` event (level `info`). Single helper, used everywhere `[flue:...]` `console.error`s exist today.
- **Update the CLI's event renderer** (`logEvent` at `packages/cli/bin/flue.ts:485`) for the full new vocab.
- **Unify sync mode's return path** with the event stream (decision 8). `runSyncMode` consumes its own event stream internally and returns `run_end.result`. Errors translate to HTTP status codes via the existing error mapping in `errors.ts`.

**Definition of done:** Examples produce the full wide-event stream with usage, durations, and structured logs. `ctx.log` works end-to-end and appears in the stream. `flue run` output is materially more useful for debugging. Type-checks green. All vocab renames documented in the changelog.

### Phase 3 — Run-scoped HTTP endpoints

Add the new endpoints (decision 9). This is mostly route plumbing; the persistence layer is ready from Phase 1 and the events are ready from Phase 2.

Concrete work:

- **`GET /agents/<name>/<id>/runs`**. Lists runs. Filter by status; paginate by `before=<runId>` cursor. Backed by `RunStore.listRuns`.
- **`GET /agents/<name>/<id>/runs/<runId>`**. Run summary. Backed by `RunStore.getRun`. 404 if absent.
- **`GET /agents/<name>/<id>/runs/<runId>/events`**. JSON events list. Filter by type, paginate by `after=<eventIndex>`. Backed by `RunStore.getEvents`. 404 if run absent.
- **`GET /agents/<name>/<id>/runs/<runId>/stream`**. SSE. **No `Last-Event-ID` handling yet** (Phase 4). For now, always streams from the start. If run is terminal, replays the full log and closes. If active, tails live events. Mount on top of the existing SSE-writing infrastructure in `runSseMode` (refactored to be reusable from this new route).
- **Mount routes in `flue()`** (`packages/sdk/src/runtime/flue-app.ts:125`). Same Hono sub-app, same per-target dispatch.
- **Cloudflare routing.** The `agents` SDK's `routeAgentRequest` routes `/agents/<name>/<id>/*` to the correct DO based on `<id>`. The new sub-paths should route the same way (verify; the `agents` SDK may need explicit pattern config).

**Definition of done:** `curl -X GET <baseUrl>/agents/hello/foo/runs` returns recent runs. `curl ... /runs/<runId>` returns the summary. `curl -N ... /runs/<runId>/stream` tails live events. Works on both Node and Cloudflare. CLI's `flue logs` command lands here (or in Phase 5; flexible).

### Phase 4 — Reconnect via Last-Event-ID

Wire up the existing SSE `id:` field to the `Last-Event-ID` request header for true reconnection.

Concrete work:

- **Read `Last-Event-ID` in the stream handler.** If present and parseable as an integer, treat as a cursor.
- **Replay-then-tail.** From the cursor (exclusive), fetch persisted events from `RunStore.getEvents(runId, fromIndex)`. Stream them out as SSE frames using their original `eventIndex` as the `id:` field. After replay, switch to live tailing — subscribe to new events on the run (if active) and forward them.
- **Live-tailing seam.** For active runs, the new endpoint subscribes to the in-flight event stream via the fan-out installed in Phase 1 (decision 16). This is the third subscriber pattern on top of persistence + handler-callback; nothing structural changes here, just a new consumer.
- **Active-run discovery.** When a stream-endpoint request arrives for an active run, the runtime needs to find the active in-process run. On CF this is "the DO is alive and running it" — same DO instance handles both POST-to-start and GET-to-stream, so an in-DO `Map<runId, EventBus>` works. On Node it's a process-global `Map<runId, EventBus>`.
- **Heartbeat continues.** The existing 25s heartbeat (`runSseMode`, `SSE_HEARTBEAT_MS`) stays.
- **Edge case: client connects after run completes.** Detect via `RunStore.getRun(runId).status`. Replay log, close stream. No live subscription needed.
- **Edge case: client connects to a run that doesn't exist.** 404 before opening SSE.
- **CF fiber-recovery interaction.** A run that was running when the DO hibernated, then recovered via `onFiberRecovered` (`build-plugin-cloudflare.ts:282`), should still be observable via stream. The `runId` in the fiber's `stash` (we'll add it there) lets the recovered fiber re-register with the in-DO `EventBus` map. Verify with a hibernation test.

**Definition of done:** `flue logs --resume <runId> --since <eventIndex>` correctly replays missing events and tails live. `EventSource` reconnect after network blip works without caller-side dedup. Both Node and CF. Hibernation+recovery on CF doesn't lose events.

### Phase 5 — CLI surfaces; polish

Land the CLI changes (decision 13) and any final polish.

Concrete work:

- **`flue run` prints `runId`.** To stderr, before streaming starts. Format documented in decision 13.
- **`flue logs <name> <id> [runId]`.** New command. Without `runId`, queries `GET /runs?limit=1` and connects to the most recent. With `runId`, connects directly. Honors `--since`, `--types`, `--follow` (v1 follow exits at `run_end`; Phase-2-of-this-plan extension would tail across runs).
- **Refactor `consumeSSE`** (`packages/cli/bin/flue.ts:604`) into a reusable function used by both `flue run` and `flue logs`.
- **Documentation.** Update `flueframework.com` docs (or wherever live docs are sourced from) with the new event vocabulary, the new endpoints, and the CLI commands. README updates in `packages/sdk` and `packages/cli`.
- **Example update.** `examples/hello-world` gets one agent that demonstrates `ctx.log` and inspects its own run history via the new endpoints. Smoke-tests the round-trip and serves as living documentation.
- **Migration note** in the changelog for the `tool_end` → `tool_call` rename and the webhook `requestId` → `runId` rename.

**Definition of done:** `flue logs hello foo` shows useful real-time output against a running agent. `flue run hello foo` prints `runId` and a user can hand it off to a separate `flue logs --resume` invocation. Docs published. Changelog written. Both examples pass end-to-end on both targets.

## What Comes After

These items are explicitly deferred. Phase 2 work, separate plan.

- **Bidirectional caller input.** `user.interrupt` first (cheapest, plumbing exists), then `user.message` (requires handler API design), then tool confirmation (requires permission model). Each is its own design pass with handler-API implications.
- **First-party caller SDK** (`@flue/client`). Typed event narrowing, automatic reconnect with `Last-Event-ID`, helpers for sync vs. streaming, browser-friendly auth. Driven by real CLI/agent-browser/app consumer needs.
- **Bring-your-own persistence on Node.** `createFlueApp({ runStore: customStore })`. SQLite + LibSQL/better-sqlite3 reference implementation for users who want Node durability. Probably ships as a separate package (`@flue/run-store-sqlite`).
- **OpenTelemetry exporter.** A `@flue/otel` package that subscribes to wide events and emits OTel spans + metrics. Each `tool_call`, `operation`, `run_end` becomes one span; `usage` fields become metrics. Trivial once the events have the right fields, which Phase 2 delivers.
- **Per-event redaction / sanitization policy.** Today, a tool that returns `{ apiKey: '...' }` will have that string in the persisted event. A configurable redaction pass at emit time, with patterns and per-tool opt-out, is a real feature for production users.
- **Sampling.** Drop a percentage of `text_delta` events (or all narrow events) on busy runs to keep persistence bounded. Today the truncation policy is the only relief valve.
- **Tail across runs.** `flue logs --follow` that doesn't exit at `run_end` and waits for subsequent runs on the same instance. Useful for "I want to see everything this instance does."
- **Instance-level admin endpoints.** `GET /agents/<name>/<id>` for instance state, sessions, recent activity. Powers an eventual admin dashboard.
- **Multi-modal events.** Image attachments in `tool_call.result` are base64 strings today. A binary-aware event payload format (with R2/S3 offload for large attachments) is the natural extension.
- **Time-based retention.** "Keep 24h of completed runs, regardless of count." Alongside or replacing the count-based ring buffer.
- **Pruning policy for long-running active runs.** A run that's been active for 6 hours and emitted 50k `text_delta` events is currently un-prunable (we always keep active runs in full). Some way to truncate the early history of a still-active run.
- **Per-stream auth tokens** for browser `EventSource` compatibility. Signed `?token=` query params with short TTLs.

## Deviations

This section is empty at start. Append a dated entry every time an architectural decision in this document is overridden by reality. Format:

### YYYY-MM-DD — Phase N: short title

**What was planned.** One paragraph.

**What changed.** Bullets or paragraphs.

**Why this is better.** One paragraph; honest about trade-offs.

**Costs accepted.** Bullets — what regression or risk this introduces.

**What changed in the plan.** Anything materially different in subsequent phases.
