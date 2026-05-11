/** Shared run-history HTTP endpoints for Node and Cloudflare targets. */

import { RunNotFoundError, RunStoreUnavailableError } from '../errors.ts';
import type { FlueEvent } from '../types.ts';
import type { RunStatus, RunStore } from './run-store.ts';

export interface HandleRunRouteOptions {
	request: Request;
	runStore?: RunStore;
	agentName: string;
	id: string;
	runId?: string;
	action: 'list' | 'get' | 'events' | 'stream';
}

const RUNS_DEFAULT_LIMIT = 20;
const RUNS_MAX_LIMIT = 100;
const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;

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
			return streamRunEvents(store, requireRunId(opts.runId));
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

async function streamRunEvents(store: RunStore, runId: string): Promise<Response> {
	await assertRunExists(store, runId);
	const events = await store.getEvents(runId);
	const body = encodeSseReplay(events);
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

async function assertRunExists(store: RunStore, runId: string): Promise<void> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });
}

function encodeSseReplay(events: FlueEvent[]): string {
	return events
		.map((event) => {
			const id = typeof event.eventIndex === 'number' ? event.eventIndex : 0;
			return [`event: ${event.type}`, `id: ${id}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
		})
		.join('');
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

function json(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}
