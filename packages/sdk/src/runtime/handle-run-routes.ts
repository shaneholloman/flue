/** Shared run-history HTTP endpoints for Node and Cloudflare targets. */

import { RunNotFoundError, RunStoreUnavailableError } from '../errors.ts';
import type { FlueEvent } from '../types.ts';
import type { RunRecord, RunStatus, RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

export interface HandleRunRouteOptions {
	request: Request;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	agentName: string;
	id: string;
	runId?: string;
	action: 'list' | 'get' | 'events' | 'stream';
}

const RUNS_DEFAULT_LIMIT = 20;
const RUNS_MAX_LIMIT = 100;
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;

/**
 * Heartbeat interval for live run-stream connections. SSE intermediaries
 * (Node's default request timeout, CDN proxies, browser EventSource
 * reconnect heuristics) all expect periodic traffic on the wire. 15s
 * matches the conservative end of common proxy timeouts.
 */
const RUN_STREAM_HEARTBEAT_MS = 15_000;

/**
 * Maximum number of events buffered between subscribing and finishing
 * replay during the replay-then-tail handoff. If exceeded, we fall back
 * to re-reading from the store after replay completes (correct, just
 * slightly slower).
 */
const REPLAY_BUFFER_CAP = 1000;

export async function handleRunRouteRequest(opts: HandleRunRouteOptions): Promise<Response> {
	const store = opts.runStore;
	if (!store) throw new RunStoreUnavailableError();

	switch (opts.action) {
		case 'list':
			return listRuns(opts.request, store, opts.id);
		case 'get':
			return getRun(store, requireRunId(opts.runId));
		case 'events':
			return getRunEvents(opts.request, store, requireRunId(opts.runId));
		case 'stream':
			return streamRunEvents(opts.request, store, opts.runSubscribers, requireRunId(opts.runId));
	}
}

async function listRuns(request: Request, store: RunStore, instanceId: string): Promise<Response> {
	const url = new URL(request.url);
	const status = parseStatus(url.searchParams.get('status'));
	const limit = parseLimit(url.searchParams.get('limit'), RUNS_DEFAULT_LIMIT, RUNS_MAX_LIMIT);
	const before = url.searchParams.get('before') ?? undefined;
	const runs = await store.listRuns(instanceId, { status, limit, before });
	return json({ runs });
}

async function getRun(store: RunStore, runId: string): Promise<Response> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });
	return json(run);
}

async function getRunEvents(request: Request, store: RunStore, runId: string): Promise<Response> {
	await assertRunExists(store, runId);
	const url = new URL(request.url);
	const after = parseEventIndex(url.searchParams.get('after'));
	const types = parseTypes(url.searchParams.get('types'));
	const limit = parseLimit(url.searchParams.get('limit'), EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT);
	let events = await store.getEvents(runId, after === undefined ? undefined : after + 1);
	if (types) events = events.filter((event) => types.has(event.type));
	return json({ events: events.slice(0, limit) });
}

/**
 * Replay-then-tail an event stream for a single run.
 *
 * Semantics:
 *
 *   - For an *already terminal* run, we replay all stored events (or those
 *     after `Last-Event-ID`) and close. There's nothing live to tail.
 *
 *   - For an *active* run:
 *       1. Subscribe to the live registry *first*. Incoming events are
 *          captured into a buffer while we read the durable replay.
 *       2. Read the durable replay from the store.
 *       3. Flush the replay to the client, deduplicating against the
 *          buffer (by `eventIndex`).
 *       4. Flush the buffer, then continue forwarding live events as they
 *          arrive.
 *       5. Close when `run_end` is observed, or when the client
 *          disconnects.
 *
 *   - `Last-Event-ID: <n>` (set by the browser's EventSource on
 *     reconnect, or by curl with `-H "Last-Event-ID: <n>"`):
 *       - Strict ascending replay of events with `eventIndex > n`.
 *       - Then, if the run is still active, switch to live tail.
 *       - Value `0` means "everything from the start".
 *
 * Subscriber registration always happens *before* we read the store
 * snapshot so we never miss the events that land between snapshot and
 * subscribe. The dedup pass handles overlap.
 */
async function streamRunEvents(
	request: Request,
	store: RunStore,
	subscribers: RunSubscriberRegistry | undefined,
	runId: string,
): Promise<Response> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });

	const lastEventId = parseLastEventId(request.headers.get('last-event-id'));
	const fromIndex = lastEventId === undefined ? undefined : lastEventId + 1;

	// If terminal already, no live tailing needed — straight replay.
	if (isTerminal(run) || !subscribers) {
		const events = await store.getEvents(runId, fromIndex);
		return sseResponse(encodeSseEvents(events));
	}

	return streamReplayThenTail({ store, subscribers, runId, fromIndex });
}

interface ReplayThenTailOptions {
	store: RunStore;
	subscribers: RunSubscriberRegistry;
	runId: string;
	fromIndex: number | undefined;
}

function streamReplayThenTail(opts: ReplayThenTailOptions): Response {
	const { store, subscribers, runId, fromIndex } = opts;
	const encoder = new TextEncoder();

	// Buffer events published between subscribe-time and end-of-replay.
	// If the buffer overflows, we set `bufferOverflowed = true` and after
	// replay we re-read from the store from the last index we sent.
	let buffer: FlueEvent[] = [];
	let bufferOverflowed = false;
	let replayDone = false;
	let lastSentIndex: number | undefined = fromIndex === undefined ? undefined : fromIndex - 1;
	let closed = false;
	let onLiveEvent: ((event: FlueEvent) => void) | undefined;
	let onClose: (() => void) | undefined;

	const subscriberListener = (event: FlueEvent) => {
		if (closed) return;
		if (!replayDone) {
			if (buffer.length >= REPLAY_BUFFER_CAP) {
				bufferOverflowed = true;
				return;
			}
			buffer.push(event);
			return;
		}
		onLiveEvent?.(event);
	};

	const unsubscribe = subscribers.subscribe(runId, subscriberListener);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					// Already closed — cleanup will fire from `cancel`.
				}
			}, RUN_STREAM_HEARTBEAT_MS);

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};
			onClose = close;

			const write = (event: FlueEvent) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(encodeSseEvent(event)));
				} catch {
					close();
					return;
				}
				if (typeof event.eventIndex === 'number') {
					lastSentIndex = event.eventIndex;
				}
				if (event.type === 'run_end') close();
			};

			onLiveEvent = write;

			// Kick off the replay→flush→live handoff. Errors thrown after the
			// SSE headers are on the wire have nowhere to go on the response
			// itself; surface them as in-stream `error` events instead.
			(async () => {
				try {
					await runReplayPhase({
						store,
						runId,
						fromIndex,
						write,
						getBuffer: () => buffer,
						drainBuffer: () => {
							const drained = buffer;
							buffer = [];
							return drained;
						},
						getBufferOverflowed: () => bufferOverflowed,
						resetBufferOverflowed: () => {
							bufferOverflowed = false;
						},
						getLastSentIndex: () => lastSentIndex,
						markReplayDone: () => {
							replayDone = true;
						},
					});

					// At this point we're live. If the run completed during replay
					// we may have already closed — nothing more to do. Otherwise,
					// keep the stream open; new events arrive via `onLiveEvent`.
				} catch (error) {
					if (closed) return;
					try {
						controller.enqueue(
							encoder.encode(encodeSseError(error, lastSentIndex)),
						);
					} catch {
						// stream already gone.
					}
					close();
				}
			})();
		},
		cancel() {
			// Client disconnected. Release the subscription and stop heartbeats.
			closed = true;
			onClose?.();
		},
	});

	return sseResponse(stream);
}

interface ReplayPhaseOptions {
	store: RunStore;
	runId: string;
	fromIndex: number | undefined;
	write: (event: FlueEvent) => void;
	getBuffer: () => FlueEvent[];
	drainBuffer: () => FlueEvent[];
	getBufferOverflowed: () => boolean;
	resetBufferOverflowed: () => void;
	getLastSentIndex: () => number | undefined;
	markReplayDone: () => void;
}

async function runReplayPhase(opts: ReplayPhaseOptions): Promise<void> {
	const {
		store,
		runId,
		fromIndex,
		write,
		drainBuffer,
		getBufferOverflowed,
		resetBufferOverflowed,
		getLastSentIndex,
		markReplayDone,
	} = opts;

	// Initial replay snapshot from the durable store.
	const replay = await store.getEvents(runId, fromIndex);
	for (const event of replay) {
		write(event);
	}

	// Drain anything that landed in the buffer while we were reading. If
	// the buffer overflowed, fall back to a second store read from
	// lastSentIndex + 1 — this maintains correctness without unbounded
	// memory.
	while (getBufferOverflowed()) {
		resetBufferOverflowed();
		const lastSent = getLastSentIndex();
		const refetchFrom = lastSent === undefined ? undefined : lastSent + 1;
		const refetched = await store.getEvents(runId, refetchFrom);
		for (const event of refetched) {
			write(event);
		}
	}

	// Drain buffered events that aren't already covered by what we wrote.
	const buffered = drainBuffer();
	for (const event of buffered) {
		const lastSent = getLastSentIndex();
		if (
			typeof event.eventIndex === 'number' &&
			lastSent !== undefined &&
			event.eventIndex <= lastSent
		) {
			continue;
		}
		write(event);
	}

	// From here on, the subscriber listener forwards live events directly.
	markReplayDone();
}

async function assertRunExists(store: RunStore, runId: string): Promise<void> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });
}

function isTerminal(run: RunRecord): boolean {
	return run.status === 'completed' || run.status === 'errored';
}

function encodeSseEvents(events: FlueEvent[]): string {
	return events.map(encodeSseEvent).join('');
}

function encodeSseEvent(event: FlueEvent): string {
	const id = typeof event.eventIndex === 'number' ? event.eventIndex : 0;
	return [`event: ${event.type}`, `id: ${id}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
}

function encodeSseError(error: unknown, lastSentIndex: number | undefined): string {
	const data = {
		message: error instanceof Error ? error.message : String(error),
	};
	const id = lastSentIndex ?? 0;
	return [`event: error`, `id: ${id}`, `data: ${JSON.stringify(data)}`, '', ''].join('\n');
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

function requireRunId(runId: string | undefined): string {
	if (!runId) throw new RunNotFoundError({ runId: '' });
	return runId;
}

function parseStatus(value: string | null): RunStatus | undefined {
	if (value === null || value === '') return undefined;
	if (value === 'active' || value === 'completed' || value === 'errored') return value;
	return undefined;
}

function parseTypes(value: string | null): Set<string> | undefined {
	if (!value) return undefined;
	const types = value
		.split(',')
		.map((type) => type.trim())
		.filter(Boolean);
	return types.length > 0 ? new Set(types) : undefined;
}

function parseLimit(value: string | null, defaultLimit: number, maxLimit: number): number {
	if (!value) return defaultLimit;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
	return Math.min(parsed, maxLimit);
}

function parseEventIndex(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

/**
 * `Last-Event-ID` is the standard SSE reconnect header. Browsers send the
 * last `id:` field they saw; the server uses it to resume from that point.
 * Malformed values are ignored — equivalent to no header.
 */
function parseLastEventId(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

function json(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}
