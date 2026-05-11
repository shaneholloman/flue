/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import { parseJsonBody, toHttpResponse } from '../errors.ts';
import type { FlueEvent } from '../types.ts';
import { generateRunId } from './ids.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

/**
 * Agent handler signature — the default export of a `.flue/agents/<name>.ts`
 * file. Receives a context, may return any JSON-serializable value (or
 * undefined for fire-and-forget agents).
 */
export type AgentHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env, defaultStore=in-memory, no resolveSandbox.
 *   - Cloudflare: env=DO env, defaultStore=DO SQLite, resolveSandbox=cfSandboxToSessionEnv.
 */
export type CreateContextFn = (
	id: string,
	runId: string,
	payload: unknown,
	request: Request,
) => FlueContextInternal;

/**
 * Webhook execution wrapper. Receives the prepared run callback and returns
 * a promise that resolves with the handler's return value. Implementations:
 *
 *   - Node: just `run()` — no fiber, no DO.
 *   - Cloudflare: `doInstance.runFiber('flue:webhook:<runId>', run)`.
 *
 * The caller is responsible for any logging on completion/error; this routine
 * just kicks it off and returns the 202.
 */
export type StartWebhookFn = (
	runId: string,
	run: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Foreground handler execution wrapper. Wraps the call to `handler(ctx)` so
 * targets can layer in keepalive / context propagation. Defaults to direct
 * invocation when omitted.
 */
export type RunHandlerFn = (
	ctx: FlueContextInternal,
	handler: AgentHandler,
) => unknown | Promise<unknown>;

export interface HandleAgentOptions {
	/** Standard Fetch Request. */
	request: Request;
	/**
	 * The agent name (URL segment). Used only in webhook completion / error
	 * log lines — routing has already happened by the time we get here.
	 */
	agentName: string;
	/** Agent id (URL segment / DO room name). */
	id: string;
	/** The agent's default-export handler. */
	handler: AgentHandler;
	/** Per-target context factory. */
	createContext: CreateContextFn;
	/**
	 * Per-target webhook runner. If omitted, fire-and-forget executes the
	 * prepared `run` callback directly (Node default — handler runs in the
	 * same process as the request handler). On Cloudflare the caller MUST
	 * provide this with a `runFiber` wrapper so the handler survives DO
	 * hibernation between the 202 ack and the actual completion.
	 */
	startWebhook?: StartWebhookFn;
	/**
	 * Per-target foreground handler wrapper. If omitted, the handler is
	 * invoked directly (Node default). On Cloudflare this is a
	 * `runWithCloudflareContext` + `keepAliveWhile` wrapper that propagates
	 * `env` via AsyncLocalStorage and prevents the DO from hibernating
	 * mid-stream.
	 */
	runHandler?: RunHandlerFn;
	/** Per-target run history store. If omitted, run persistence is disabled. */
	runStore?: RunStore;
	/**
	 * Per-target in-process subscriber registry used by the run-stream
	 * route to live-tail an active run. Optional — if omitted, the run
	 * still produces events and is persisted, but live-tail subscribers
	 * see only what's already in the store at the moment they connect.
	 */
	runSubscribers?: RunSubscriberRegistry;
}

/**
 * Dispatch a single `/agents/:name/:id` request. The mode is chosen by
 * inspecting headers:
 *
 *   - `X-Webhook: true` → fire-and-forget. Returns 202 immediately; the
 *     handler runs in the background. Errors are logged server-side.
 *   - `Accept: text/event-stream` (and not webhook) → SSE streaming. Returns
 *     200 + text/event-stream. Events come from the FlueContext's event
 *     callback; final result is appended as `event: result`. Per-event errors
 *     surface as `event: error` envelopes.
 *   - Otherwise → sync. Returns 200 + JSON `{ result }`.
 *
 * Errors thrown BEFORE streaming starts (body parse, agent lookup) bubble
 * out as a `Response` via {@link toHttpResponse} — headers haven't been sent
 * yet, so a regular HTTP error is still possible. Errors thrown AFTER the
 * 200 + text/event-stream headers are on the wire (i.e. inside the agent
 * handler) get framed as in-stream `error` events instead.
 *
 * Caller is responsible for routing — this function assumes the request has
 * already been validated as a POST against a registered agent.
 */
export async function handleAgentRequest(opts: HandleAgentOptions): Promise<Response> {
	const { request, agentName, id, handler, createContext, runStore, runSubscribers } = opts;
	const startWebhook = opts.startWebhook ?? defaultStartWebhook;
	const runHandler = opts.runHandler ?? defaultRunHandler;
	const runId = generateRunId();

	try {
		// Parse the request body. Throws on invalid Content-Type or malformed
		// JSON; returns {} for genuinely empty bodies (so no-payload agents
		// still work).
		const payload = await parseJsonBody(request);

		const accept = request.headers.get('accept') || '';
		const isWebhook = request.headers.get('x-webhook') === 'true';
		const isSSE = accept.includes('text/event-stream') && !isWebhook;

		if (isWebhook) {
			return runWebhookMode({
				agentName,
				id,
				runId,
				handler,
				payload,
				request,
				createContext,
				startWebhook,
				runStore,
				runSubscribers,
			});
		}

		if (isSSE) {
			return runSseMode({
				agentName,
				id,
				runId,
				handler,
				payload,
				request,
				createContext,
				runHandler,
				runStore,
				runSubscribers,
			});
		}

		return runSyncMode({
			agentName,
			id,
			runId,
			handler,
			payload,
			request,
			createContext,
			runHandler,
			runStore,
			runSubscribers,
		});
	} catch (err) {
		// toHttpResponse logs unknowns via flueLog.error — no extra console.error
		// needed at this layer.
		const response = toHttpResponse(err);
		response.headers.set('X-Flue-Run-Id', runId);
		return response;
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

interface ModeOptions {
	agentName: string;
	id: string;
	runId: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
}

interface WebhookOptions {
	agentName: string;
	id: string;
	runId: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWebhook: StartWebhookFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
}

async function runWebhookMode(opts: WebhookOptions): Promise<Response> {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		startWebhook,
		runStore,
		runSubscribers,
	} = opts;

	// Webhook execution intentionally does NOT go through `runHandler`:
	//
	//   - On Cloudflare, fire-and-forget runs through `runFiber` (provided by
	//     the caller's `startWebhook`), which already takes care of keeping
	//     the DO alive across the request lifetime. Layering `keepAliveWhile`
	//     on top would be redundant.
	//   - On Node, there's nothing to wrap in either mode.
	//
	// The handler runs directly here; the caller's `startWebhook` is the
	// only execution-context wrapper.
	//
	// `ctx` is created up here (outside `run`) so it lands outside any
	// AsyncLocalStorage scope the caller's `startWebhook` may set up. This
	// matches the pre-refactor sync/SSE behavior and the pre-refactor
	// Cloudflare webhook behavior, where ctx construction always happened
	// before entering `runWithCloudflareContext`. The factory is pure today,
	// but keeping the timing consistent across modes avoids surprises if it
	// ever grows ambient-env dependencies.
	const lifecycle = await createRunLifecycle({
		agentName,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
	});
	const { ctx } = lifecycle;
	const run = async (): Promise<unknown> =>
		withRunLifecycle(lifecycle, () => handler(ctx));

	startWebhook(runId, run).then(
		(result) => {
			console.log(
				'[flue] Webhook handler complete:',
				agentName,
				result !== undefined ? JSON.stringify(result) : '(no return)',
			);
		},
		(err) => {
			console.error('[flue] Webhook handler error:', agentName, err);
		},
	);

	return new Response(JSON.stringify({ status: 'accepted', runId }), {
		status: 202,
		headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': runId },
	});
}

/**
 * Heartbeat interval for long-idle SSE streams. The actual cadence matters
 * less than the existence of *some* periodic payload — the heartbeat exists
 * to defeat intermediary timeouts (Node's default 300s requestTimeout, CDN
 * proxies, browser EventSource reconnect heuristics). 25s is the conventional
 * choice and matches what Hono's `streamSSE` defaults to.
 */
const SSE_HEARTBEAT_MS = 25_000;

function runSseMode(opts: ModeOptions): Response {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		runHandler,
		runStore,
		runSubscribers,
	} = opts;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let isIdle = false;
	let closed = false;

	// Write helpers swallow errors from `writer.write` because once a stream
	// fails (typically on client disconnect) every subsequent write fails
	// the same way. Without the catch, the FIRST write after disconnect
	// would throw out of the IIFE below as an unhandled rejection, and any
	// `error`-event recovery write inside the catch block would itself
	// throw — making cleanup unreliable. Swallowing here lets the handler
	// finish naturally; events written after disconnect are simply dropped.
	//
	// `eventIndex` is non-optional on decorated events (see `client.ts`),
	// so the SSE `id:` field always reflects the durable position — which
	// is what `Last-Event-ID` reconnects depend on.
	const writeSSE = async (data: unknown, eventType: string): Promise<void> => {
		if (closed) return;
		const eventIndex = getEventIndex(data) ?? 0;
		const lines: string[] = [];
		lines.push(`event: ${eventType}`);
		lines.push(`id: ${eventIndex}`);
		lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
		lines.push('', '');
		try {
			await writer.write(encoder.encode(lines.join('\n')));
		} catch {
			// see writeSSE rationale above
		}
	};

	const writeHeartbeat = async (): Promise<void> => {
		if (closed) return;
		try {
			await writer.write(encoder.encode(': heartbeat\n\n'));
		} catch {
			// see writeSSE rationale above
		}
	};

	// Heartbeat keeps long-idle streams alive across intermediary timeouts
	// (e.g. Node's default 300s request timeout — disabled at the server
	// level for /agents routes, but the heartbeat is a defense-in-depth
	// layer for any other proxies).
	const heartbeat = setInterval(() => {
		writeHeartbeat().catch(() => {});
	}, SSE_HEARTBEAT_MS);

	// Spawn the body. Errors during execution surface as in-stream `error`
	// events because the 200 + text/event-stream headers are already on the
	// wire by the time we await this promise.
	(async () => {
		const lifecycle = await createRunLifecycle({
			agentName,
			id,
			runId,
			payload,
			request,
			createContext,
			runStore,
			runSubscribers,
		});
		const { ctx } = lifecycle;
		ctx.setEventCallback((event) => {
			if (event.type === 'idle') isIdle = true;
			writeSSE(event, event.type).catch(() => {});
		});

		try {
			await withRunLifecycle(lifecycle, async () => {
				try {
					return await runHandler(ctx, handler);
				} finally {
					// `idle` always fires before `run_end` (which the
					// wrapper emits) so the wire order matches what
					// in-process consumers saw before Phase 6.
					if (!isIdle) ctx.emitEvent({ type: 'idle' });
				}
			});
		} catch {
			// `withRunLifecycle` already emitted `run_end` with the error
			// envelope and persisted it durably. The body's errors are
			// already visible to the SSE client via the `setEventCallback`
			// above; we swallow here so the IIFE doesn't reject.
		} finally {
			clearInterval(heartbeat);
			ctx.setEventCallback(undefined);
			closed = true;
			try {
				await writer.close();
			} catch {
				// Already closed by the client / runtime — nothing to do.
			}
		}
	})();

	return new Response(readable, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'X-Flue-Run-Id': runId,
		},
	});
}

async function runSyncMode(opts: ModeOptions): Promise<Response> {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		runHandler,
		runStore,
		runSubscribers,
	} = opts;
	const lifecycle = await createRunLifecycle({
		agentName,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
	});
	const { ctx } = lifecycle;
	try {
		const result = await withRunLifecycle(lifecycle, () => runHandler(ctx, handler));
		return new Response(
			JSON.stringify({ result: result === undefined ? null : result, _meta: { runId } }),
			{ headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': runId } },
		);
	} finally {
		ctx.setEventCallback(undefined);
	}
}

// ─── Run lifecycle ──────────────────────────────────────────────────────────

interface RunLifecycleOptions {
	agentName: string;
	id: string;
	runId: string;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
}

interface RunLifecycle extends RunLifecycleOptions {
	ctx: FlueContextInternal;
	startedAt: string;
	startedAtMs: number;
}

async function createRunLifecycle(options: RunLifecycleOptions): Promise<RunLifecycle> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const ctx = options.createContext(options.id, options.runId, options.payload, options.request);
	await safeRunStore('createRun', () =>
		options.runStore?.createRun({
			runId: options.runId,
			instanceId: options.id,
			agentName: options.agentName,
			startedAt,
			payload: options.payload,
		}),
	);
	return { ...options, ctx, startedAt, startedAtMs };
}

/**
 * Wrap the per-mode body with the run lifecycle:
 *
 *   1. Subscribe the durable + live fan-out (all events except `run_end`).
 *   2. Emit `run_start`.
 *   3. Run the body.
 *   4. Emit `run_end` durably-before-live (see {@link emitRunEnd}).
 *   5. Tear down the fan-out subscription.
 *
 * Centralizing this eliminates three near-identical envelopes in the
 * mode functions and — critically — guarantees the run-end ordering
 * invariant holds for every mode.
 */
async function withRunLifecycle<T>(
	lifecycle: RunLifecycle,
	body: () => T | Promise<T>,
): Promise<T> {
	const unsubscribeFanout = subscribeRunFanout(lifecycle);
	emitRunStart(lifecycle);
	try {
		const result = await body();
		await emitRunEnd(lifecycle, { result, isError: false });
		return result;
	} catch (error) {
		await emitRunEnd(lifecycle, { isError: true, error });
		throw error;
	} finally {
		unsubscribeFanout();
	}
}

function emitRunStart(lifecycle: RunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_start',
		runId: lifecycle.runId,
		instanceId: lifecycle.id,
		agentName: lifecycle.agentName,
		startedAt: lifecycle.startedAt,
		payload: lifecycle.payload,
	});
}

/**
 * Emit `run_end` and finalize the run.
 *
 * Ordering invariant — "durable terminal state happens before observable
 * terminal state":
 *
 *   1. `appendEvent(run_end)` durably. We intercept `run_end` in
 *      {@link subscribeRunFanout} so the generic fan-out does NOT
 *      double-persist it — that path can't await the write, which is
 *      exactly what we need to control here.
 *   2. `publish(run_end)` to live subscribers. Any client subscribed
 *      before this fires sees `run_end` and closes naturally.
 *   3. `endRun` durably, flipping the run row to `completed`/`errored`.
 *      Only after this point does `getRun` report terminal status; any
 *      client connecting from now takes the pure-replay path.
 *   4. `complete(runId)` releases the live subscriber registry bucket.
 *
 * This closes the race where a client opens `/runs/<runId>/stream`
 * between `publish(run_end)` and `endRun`: under the old order the
 * stream would take the live path, miss the already-published
 * `run_end`, and hang. Now the durable-snapshot path always sees
 * `run_end` first.
 *
 * `ctx.emitEvent` is still called for `run_end` so in-process consumers
 * (other `ctx.subscribeEvent` listeners, the SSE-mode write callback)
 * receive it on the same channel as every other event. The fan-out's
 * `run_end` filter prevents double-persistence / double-publish.
 */
async function emitRunEnd(
	lifecycle: RunLifecycle,
	input: { result?: unknown; isError: false } | { isError: true; error: unknown },
): Promise<void> {
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - lifecycle.startedAtMs;
	const result = input.isError ? undefined : input.result;
	const error = input.isError ? serializeError(input.error) : undefined;
	const normalizedResult = result === undefined ? null : result;

	const { runStore, runSubscribers, runId } = lifecycle;

	// Construct the event and decorate it through the same channel as
	// every other event so eventIndex/timestamp are continuous.
	// `subscribeRunFanout` will see this through `subscribeEvent` and
	// skip it (run_end is handled here, not in the fan-out).
	const decorated = lifecycle.ctx.emitEvent({
		type: 'run_end',
		runId,
		result: normalizedResult,
		isError: input.isError,
		error,
		durationMs,
	});

	// 1. Durable append BEFORE any observer can react to terminal state.
	await safeRunStore('appendEvent(run_end)', () =>
		runStore?.appendEvent(runId, decorated),
	);

	// 2. Notify live subscribers. They get the same decorated event the
	//    durable snapshot now has.
	runSubscribers?.publish(runId, decorated);

	// 3. Flip the run row to terminal. After this, every `/stream` call
	//    takes the pure-replay path.
	await safeRunStore('endRun', () =>
		runStore?.endRun({
			runId,
			endedAt,
			isError: input.isError,
			durationMs,
			result,
			error,
		}),
	);

	// 4. Release the registry bucket. No new subscribers should arrive
	//    after (3), but any that did during the (2)→(3) gap have already
	//    received `run_end` and closed.
	runSubscribers?.complete(runId);
}

/**
 * Fan-out: durable-before-live for every event EXCEPT `run_end`.
 *
 * Non-`run_end` events:
 *   - `await runStore.appendEvent(...)` first.
 *   - Then `runSubscribers.publish(...)` synchronously.
 *
 * `run_end` is intentionally skipped here; {@link emitRunEnd} handles
 * its durable-append, publish, and the terminal `endRun` transition in
 * a single controlled sequence (see emitRunEnd's doc for the
 * invariant).
 *
 * Both sinks are best-effort: errors are logged but never propagated.
 */
function subscribeRunFanout(lifecycle: RunLifecycle): () => void {
	const { ctx, runStore, runSubscribers, runId } = lifecycle;
	if (!runStore && !runSubscribers) return () => {};
	return ctx.subscribeEvent((event) => {
		if (event.type === 'run_end') return;
		void fanOutEvent(runStore, runSubscribers, runId, event);
	});
}

async function fanOutEvent(
	runStore: RunStore | undefined,
	runSubscribers: RunSubscriberRegistry | undefined,
	runId: string,
	event: FlueEvent,
): Promise<void> {
	if (runStore) {
		try {
			await runStore.appendEvent(runId, event);
		} catch (error) {
			console.error('[flue:run-store] appendEvent failed:', error);
		}
	}
	runSubscribers?.publish(runId, event);
}

async function safeRunStore(label: string, fn: () => Promise<void> | undefined): Promise<void> {
	try {
		await fn();
	} catch (error) {
		console.error(`[flue:run-store] ${label} failed:`, error);
	}
}

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return error;
}

function getEventIndex(data: unknown): number | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const value = (data as { eventIndex?: unknown }).eventIndex;
	return typeof value === 'number' ? value : undefined;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Default webhook runner: invoke `run()` directly so the handler executes
 * in the current process. Used by the Node target. The Cloudflare target
 * overrides this with a `runFiber` wrapper for crash-recoverable execution
 * across DO hibernation.
 */
const defaultStartWebhook: StartWebhookFn = (_runId, run) => run();

/**
 * Default foreground handler runner: invoke directly. Used by the Node
 * target. The Cloudflare target overrides this with a `keepAliveWhile`
 * wrapper.
 */
const defaultRunHandler: RunHandlerFn = (ctx, handler) => handler(ctx);
