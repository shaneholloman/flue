import type { BackoffOptions } from '@durable-streams/client';
import type { FlueConversationSnapshot, FlueConversationState } from './conversation.ts';
import {
	applyConversationChunk,
	type ConversationStreamChunk,
	createConversationStreamState,
} from './conversation-stream.ts';
import type { FlueEventStream } from './stream.ts';

/**
 * Live mode for conversation observation. Deliberately excludes `'sse'`.
 *
 * The `message-delta` protocol is append-style with no per-delta sequence: a
 * delta extends the current streaming part. Correct application therefore
 * requires the transport to deliver each batch atomically with its resume
 * offset, so a reconnect never re-delivers a batch that was already applied.
 * Long-poll (`true` / `'long-poll'`) and one-shot (`false`) satisfy this — each
 * batch arrives with its `Stream-Next-Offset` in one response. SSE does not: it
 * splits a batch across `data` and `control` frames, and the durable-stream
 * client transparently reconnects from the pre-batch offset if the connection
 * drops between them, re-delivering (and thus double-applying) the batch. Across
 * reconnects, `observe()` rehydrates a fresh snapshot rather than resuming, so
 * the only redelivery risk is that intra-session SSE window — which excluding
 * SSE removes entirely.
 */
export type ConversationLiveMode = boolean | 'long-poll';

export type AgentConversationObservationPhase =
	| 'loading'
	| 'connecting'
	| 'live'
	| 'up-to-date'
	| 'absent'
	| 'error'
	| 'closed';

export interface AgentConversationObservationSnapshot {
	conversation: FlueConversationState | undefined;
	offset: string | undefined;
	phase: AgentConversationObservationPhase;
	error: Error | undefined;
}

export interface AgentConversationObserveOptions {
	live?: ConversationLiveMode;
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
}

export interface AgentConversationObservation {
	getSnapshot(): AgentConversationObservationSnapshot;
	subscribe(listener: () => void): () => void;
	refresh(): void;
	close(reason?: unknown): void;
}

/**
 * Internal composition seam between SDK transport and the observation state
 * machine. Not exported from the package: `client.agents.observe()` is the only
 * supported way to construct an observation. Tests drive observation through a
 * fake {@link AgentConversationObservationSource}.
 */
export interface AgentConversationObservationSource {
	history(options: { signal?: AbortSignal }): Promise<FlueConversationSnapshot>;
	updates(options: {
		offset: string;
		live?: ConversationLiveMode;
		signal?: AbortSignal;
		backoffOptions?: BackoffOptions;
	}): FlueEventStream<ConversationStreamChunk>;
}

export function createAgentConversationObservation(
	source: AgentConversationObservationSource,
	options: AgentConversationObserveOptions = {},
): AgentConversationObservation {
	const listeners = new Set<() => void>();
	let streamState: FlueConversationState | undefined;
	let snapshot: AgentConversationObservationSnapshot = {
		conversation: undefined,
		offset: undefined,
		phase: 'loading',
		error: undefined,
	};
	let started = false;
	let closed = false;
	let generation = 0;
	let controller: AbortController | undefined;
	let removeExternalAbortListener: (() => void) | undefined;
	let stream: FlueEventStream<ConversationStreamChunk> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;

	const publish = (next: AgentConversationObservationSnapshot) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};

	const isCurrent = (value: number) => !closed && value === generation;

	const clearActive = () => {
		removeExternalAbortListener?.();
		removeExternalAbortListener = undefined;
		controller?.abort();
		controller = undefined;
		stream?.cancel();
		stream = undefined;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	};

	// Every reconnect rehydrates a fresh snapshot rather than resuming the
	// incremental stream. Streaming deltas append to the current part without a
	// per-delta sequence, so resuming after a batch-granular offset could
	// re-apply a redelivered batch; a clean snapshot reset makes application
	// exactly-once. This mirrors the durable-stream reference (reset/refetch on
	// reconnect) and is cheap because `history()` is server-materialized.
	const scheduleRetry = (value: number, error: Error) => {
		if (!isCurrent(value)) return;
		if (controller?.signal.aborted) {
			publish({ ...snapshot, phase: 'closed', error: undefined });
			return;
		}
		if (isFatalStatus(error)) {
			publish({ ...snapshot, phase: 'error', error });
			return;
		}
		publish({ ...snapshot, phase: 'connecting', error });
		const delay = Math.min(1000 * 2 ** reconnectAttempt++, 30_000);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (!isCurrent(value)) return;
			void hydrate(value);
		}, delay);
	};

	const follow = async (value: number, offset: string) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: options.live === false ? 'connecting' : 'live', error: undefined });
		let nextStream: FlueEventStream<ConversationStreamChunk>;
		try {
			nextStream = source.updates({
				offset,
				live: options.live,
				signal: controller?.signal,
				backoffOptions: options.backoffOptions,
			});
		} catch (error) {
			scheduleRetry(value, toError(error));
			return;
		}
		stream = nextStream;
		try {
			for await (const chunk of nextStream) {
				if (!isCurrent(value) || stream !== nextStream) return;
				if (!streamState) throw new Error('Agent conversation updates require materialized state.');
				streamState = applyConversationChunk(streamState, chunk);
				publish({
					conversation: streamState,
					offset: nextStream.offset,
					phase: options.live === false ? 'connecting' : 'live',
					error: undefined,
				});
				reconnectAttempt = 0;
			}
			if (!isCurrent(value) || stream !== nextStream) return;
			const nextOffset = nextStream.offset;
			stream = undefined;
			if (options.live === false) {
				publish({ ...snapshot, offset: nextOffset, phase: 'up-to-date', error: undefined });
				return;
			}
			scheduleRetry(value, new Error('Agent conversation stream ended unexpectedly.'));
		} catch (error) {
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			scheduleRetry(value, toError(error));
		}
	};

	const hydrate = async (value: number) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: streamState ? 'connecting' : 'loading', error: undefined });
		try {
			const history = await source.history({ signal: controller?.signal });
			if (!isCurrent(value)) return;
			streamState = createConversationStreamState(history);
			reconnectAttempt = 0;
			publish({
				conversation: streamState,
				offset: history.offset,
				phase: 'connecting',
				error: undefined,
			});
			await follow(value, history.offset);
		} catch (error) {
			if (!isCurrent(value)) return;
			const normalized = toError(error);
			if (statusOf(error) === 404) {
				streamState = undefined;
				reconnectAttempt = 0;
				publish({ conversation: undefined, offset: undefined, phase: 'absent', error: undefined });
				return;
			}
			scheduleRetry(value, normalized);
		}
	};

	const begin = () => {
		generation++;
		controller = new AbortController();
		removeExternalAbortListener = linkSignal(options.signal, controller, () => {
			if (!closed) {
				closed = true;
				generation++;
				clearActive();
				publish({ ...snapshot, phase: 'closed', error: undefined });
			}
		});
		reconnectAttempt = 0;
		const value = generation;
		queueMicrotask(() => void hydrate(value));
	};

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			if (!started && !closed) {
				started = true;
				begin();
			}
			return () => listeners.delete(listener);
		},
		refresh() {
			if (closed) return;
			clearActive();
			started = true;
			begin();
		},
		close(reason) {
			if (closed) return;
			closed = true;
			generation++;
			clearActive();
			publish({ ...snapshot, phase: 'closed', error: reason === undefined ? undefined : toError(reason) });
			listeners.clear();
		},
	};
}

function linkSignal(
	signal: AbortSignal | undefined,
	controller: AbortController,
	onAbort: () => void,
): (() => void) | undefined {
	if (!signal) return undefined;
	if (signal.aborted) {
		controller.abort(signal.reason);
		onAbort();
	} else {
		const handler = () => {
			controller.abort(signal.reason);
			onAbort();
		};
		signal.addEventListener('abort', handler, { once: true });
		return () => signal.removeEventListener('abort', handler);
	}
	return undefined;
}

function statusOf(error: unknown): number | undefined {
	return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
		? error.status
		: undefined;
}

function isFatalStatus(error: unknown): boolean {
	const status = statusOf(error);
	return status === 400 || status === 401 || status === 403;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
