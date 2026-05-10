/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import { parseJsonBody, toHttpResponse, toSseData } from '../error-utils.ts';
import type { FlueContextInternal } from '../client.ts';

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
	payload: unknown,
	request: Request,
) => FlueContextInternal;

/**
 * Webhook execution wrapper. Receives the prepared run callback and returns
 * a promise that resolves with the handler's return value. Implementations:
 *
 *   - Node: just `run()` — no fiber, no DO.
 *   - Cloudflare: `doInstance.runFiber('flue:webhook:<requestId>', run)`.
 *
 * The caller is responsible for any logging on completion/error; this routine
 * just kicks it off and returns the 202.
 */
export type StartWebhookFn = (
	requestId: string,
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
	const { request, agentName, id, handler, createContext } = opts;
	const startWebhook = opts.startWebhook ?? defaultStartWebhook;
	const runHandler = opts.runHandler ?? defaultRunHandler;

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
				handler,
				payload,
				request,
				createContext,
				startWebhook,
			});
		}

		if (isSSE) {
			return runSseMode({
				id,
				handler,
				payload,
				request,
				createContext,
				runHandler,
			});
		}

		return runSyncMode({
			id,
			handler,
			payload,
			request,
			createContext,
			runHandler,
		});
	} catch (err) {
		// toHttpResponse logs unknowns via flueLog.error — no extra console.error
		// needed at this layer.
		return toHttpResponse(err);
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

interface ModeOptions {
	id: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler: RunHandlerFn;
}

interface WebhookOptions {
	agentName: string;
	id: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWebhook: StartWebhookFn;
}

function runWebhookMode(opts: WebhookOptions): Response {
	const { agentName, id, handler, payload, request, createContext, startWebhook } = opts;
	const requestId = generateRequestId();

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
	const ctx = createContext(id, payload, request);
	const run = async (): Promise<unknown> => {
		try {
			return await handler(ctx);
		} finally {
			ctx.setEventCallback(undefined);
		}
	};

	startWebhook(requestId, run).then(
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

	return new Response(JSON.stringify({ status: 'accepted', requestId }), {
		status: 202,
		headers: { 'content-type': 'application/json' },
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
	const { id, handler, payload, request, createContext, runHandler } = opts;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let eventId = 0;
	let isIdle = false;
	let closed = false;

	// Write helpers swallow errors from `writer.write` because once a stream
	// fails (typically on client disconnect) every subsequent write fails
	// the same way. Without the catch, the FIRST write after disconnect
	// would throw out of the IIFE below as an unhandled rejection, and any
	// `error`-event recovery write inside the catch block would itself
	// throw — making cleanup unreliable. Swallowing here lets the handler
	// finish naturally; events written after disconnect are simply dropped.
	const writeSSE = async (data: unknown, event: string): Promise<void> => {
		if (closed) return;
		const lines: string[] = [];
		lines.push(`event: ${event}`);
		lines.push(`id: ${eventId++}`);
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

	const ctx = createContext(id, payload, request);
	ctx.setEventCallback((event) => {
		if (event.type === 'idle') isIdle = true;
		writeSSE(event, event.type).catch(() => {});
	});

	// Spawn the body. Errors during execution surface as in-stream `error`
	// events because the 200 + text/event-stream headers are already on the
	// wire by the time we await this promise.
	(async () => {
		try {
			const result = await runHandler(ctx, handler);
			if (!isIdle) {
				await writeSSE({ type: 'idle' }, 'idle');
			}
			await writeSSE(
				{ type: 'result', data: result !== undefined ? result : null },
				'result',
			);
		} catch (err) {
			await writeSSE(toSseData(err), 'error');
			if (!isIdle) {
				await writeSSE({ type: 'idle' }, 'idle');
			}
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
		},
	});
}

async function runSyncMode(opts: ModeOptions): Promise<Response> {
	const { id, handler, payload, request, createContext, runHandler } = opts;
	const ctx = createContext(id, payload, request);
	try {
		const result = await runHandler(ctx, handler);
		return new Response(
			JSON.stringify({ result: result !== undefined ? result : null }),
			{ headers: { 'content-type': 'application/json' } },
		);
	} finally {
		ctx.setEventCallback(undefined);
	}
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Default webhook runner: invoke `run()` directly so the handler executes
 * in the current process. Used by the Node target. The Cloudflare target
 * overrides this with a `runFiber` wrapper for crash-recoverable execution
 * across DO hibernation.
 */
const defaultStartWebhook: StartWebhookFn = (_requestId, run) => run();

/**
 * Default foreground handler runner: invoke directly. Used by the Node
 * target. The Cloudflare target overrides this with a `keepAliveWhile`
 * wrapper.
 */
const defaultRunHandler: RunHandlerFn = (ctx, handler) => handler(ctx);

/**
 * Generate a UUID for webhook request correlation. `crypto.randomUUID()` is
 * available on both modern Node (≥18) and workerd, so no per-target shim is
 * needed.
 */
function generateRequestId(): string {
	return crypto.randomUUID();
}
