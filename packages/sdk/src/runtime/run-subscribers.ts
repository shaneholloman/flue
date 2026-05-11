/**
 * Per-run, in-process subscriber registry for live SSE tailing.
 *
 * The {@link RunStore} is the durable source of truth — but durable replay
 * alone can't power a live `/runs/<runId>/stream` because subscribers join
 * after events have already been produced and need to keep receiving new
 * ones as the run progresses. The subscriber registry sits next to the
 * store on the same in-memory path: whenever the run dispatcher emits a
 * decorated event, it both `appendEvent`s to the store *and* publishes
 * to the registry. Live SSE handlers subscribe to the registry; once
 * subscribed, they get every subsequent event for the run.
 *
 * On Cloudflare, the registry lives inside the Agent Durable Object — the
 * same DO that owns the run's event production and the SQLite-backed
 * store. Single-writer naturally; no cross-DO coordination.
 *
 * On Node, the registry is a module-level singleton paired with the
 * Node in-memory store. Single-process; partitioning is implicit via the
 * run id.
 */

import type { FlueEvent } from '../types.ts';

export type RunSubscriberListener = (event: FlueEvent) => void;

export interface RunSubscriberRegistry {
	subscribe(runId: string, listener: RunSubscriberListener): () => void;
	publish(runId: string, event: FlueEvent): void;
	/**
	 * Called when a run has reached a terminal state. Implementations may
	 * use this to release any registry-internal state for that run. The
	 * terminal event itself MUST have already been published before this
	 * is called.
	 */
	complete(runId: string): void;
}

export function createRunSubscriberRegistry(): RunSubscriberRegistry {
	const listeners = new Map<string, Set<RunSubscriberListener>>();

	return {
		subscribe(runId, listener) {
			let bucket = listeners.get(runId);
			if (!bucket) {
				bucket = new Set();
				listeners.set(runId, bucket);
			}
			bucket.add(listener);
			return () => {
				const current = listeners.get(runId);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) listeners.delete(runId);
			};
		},
		publish(runId, event) {
			const bucket = listeners.get(runId);
			if (!bucket || bucket.size === 0) return;
			// Snapshot to a local array so listeners that unsubscribe
			// themselves during dispatch don't perturb the iteration.
			for (const listener of [...bucket]) {
				try {
					listener(event);
				} catch (error) {
					console.error('[flue:run-subscribers] listener threw:', error);
				}
			}
		},
		complete(runId) {
			listeners.delete(runId);
		},
	};
}
