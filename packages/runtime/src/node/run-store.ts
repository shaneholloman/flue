import {
	type CreateRunInput,
	type EndRunInput,
	type RunRecord,
	type RunStore,
	serializedEventForPersistence,
} from '../runtime/run-store.ts';
import type { FlueEvent } from '../types.ts';

interface InstanceRuns {
	runs: Map<string, RunRecord>;
	events: Map<string, StoredRunEvent[]>;
}

interface StoredRunEvent {
	eventIndex?: number;
	payload: string;
}

export class InMemoryRunStore implements RunStore {
	private instances = new Map<string, InstanceRuns>();

	async createRun(input: CreateRunInput): Promise<void> {
		if (input.owner.instanceId !== input.runId) {
			throw new Error(
				'[flue] Workflow run owners must use the same instanceId as the run record runId.',
			);
		}
		const instance = this.getInstance(ownerKey(input.owner));
		instance.runs.set(input.runId, {
			runId: input.runId,
			owner: input.owner,
			status: 'active',
			startedAt: input.startedAt,
			payload: input.payload,
		});
		instance.events.set(input.runId, []);
	}

	async endRun(input: EndRunInput): Promise<void> {
		const existing = await this.getRun(input.runId);
		if (!existing) return;
		const instance = this.getInstance(ownerKey(existing.owner));
		instance.runs.set(input.runId, {
			...existing,
			status: input.isError ? 'errored' : 'completed',
			endedAt: input.endedAt,
			isError: input.isError,
			durationMs: input.durationMs,
			result: input.result,
			error: input.error,
		});
	}

	async appendEvent(runId: string, event: FlueEvent): Promise<void> {
		const run = await this.getRun(runId);
		if (!run) return;
		const instance = this.getInstance(ownerKey(run.owner));
		const events = instance.events.get(runId) ?? [];
		events.push({ eventIndex: event.eventIndex, payload: serializedEventForPersistence(event) });
		instance.events.set(runId, events);
	}

	async getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]> {
		const run = await this.getRun(runId);
		if (!run) return [];
		const events = this.getInstance(ownerKey(run.owner)).events.get(runId) ?? [];
		return events
			.filter(
				(event) =>
					fromIndex === undefined ||
					(typeof event.eventIndex === 'number' && event.eventIndex >= fromIndex),
			)
			.map((event) => JSON.parse(event.payload) as FlueEvent);
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		for (const instance of this.instances.values()) {
			const run = instance.runs.get(runId);
			if (run) return run;
		}
		return null;
	}

	private getInstance(key: string): InstanceRuns {
		let instance = this.instances.get(key);
		if (!instance) {
			instance = { runs: new Map(), events: new Map() };
			this.instances.set(key, instance);
		}
		return instance;
	}
}

function ownerKey(owner: CreateRunInput['owner']): string {
	return `workflow\0${owner.workflowName}\0${owner.instanceId}`;
}
