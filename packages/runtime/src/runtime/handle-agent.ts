/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import * as v from 'valibot';
import { parseActionInput, runActionWithParsedInput } from '../action.ts';
import type { FlueContextInternal } from '../client.ts';
import { isWorkflowDefinition, type WorkflowDefinition } from '../workflow-definition.ts';
import {
	InvalidRequestError,
	parseJsonBody,
	RunStoreUnavailableError,
	toHttpResponse,
} from '../errors.ts';
import type {
	AttachedAgentEventCallback,
	DirectAgentPayload,
	FlueEvent,
	FlueEventCallback,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import {
	agentStreamPath,
	type EventStreamStore,
	parseOffset,
	runStreamPath,
} from './event-stream-store.ts';

import { generateWorkflowRunId } from './ids.ts';
import { isBufferedRunEvent, isStreamExcludedEvent, type RunStore } from './run-store.ts';
import { DirectAgentPayloadSchema } from './schemas.ts';

export type WorkflowRegistry = Record<string, WorkflowDefinition>;

export function assertWorkflowDefinition(value: unknown, name: string): asserts value is WorkflowDefinition {
	if (!isWorkflowDefinition(value)) {
		throw new Error(`[flue] Workflow "${name}" must default-export defineWorkflow(...).`);
	}
}

export function assertAgentDispatchAdmissionInput(input: unknown): asserts input is DispatchInput {
	if (!isDispatchInput(input))
		throw new Error('[flue] Internal dispatch admission received an invalid payload.');
}

function isDispatchInput(value: unknown): value is DispatchInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<DispatchInput>;
	return (
		typeof input.dispatchId === 'string' &&
		input.dispatchId.trim() !== '' &&
		typeof input.agent === 'string' &&
		input.agent.trim() !== '' &&
		typeof input.id === 'string' &&
		input.id.trim() !== '' &&
		input.input !== undefined &&
		typeof input.acceptedAt === 'string' &&
		input.acceptedAt.trim() !== ''
	);
}

function parseDirectAgentPayload(payload: unknown): DirectAgentPayload {
	const parsed = v.safeParse(DirectAgentPayloadSchema, payload);
	if (parsed.success) return parsed.output;
	const oversizedImageIssue = parsed.issues.find((issue) => issue.type === 'max_length');
	throw new InvalidRequestError({
		reason:
			oversizedImageIssue?.message ??
			'Direct agent requests must use JSON object body { "message": string, "images"?: image[] }.',
	});
}

/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env, defaultStore=in-memory.
 *   - Cloudflare: env=DO env, defaultStore=DO SQLite.
 */
export type CreateContextFn = (
	id: string,
	runId: string | undefined,
	request: Request,
	initialEventIndex?: number,
	dispatchId?: string,
) => FlueContextInternal;

/**
 * Background workflow admission wrapper. Receives the prepared workflow-run
 * callback and returns a promise that resolves with its result. Implementations:
 *
 *   - Node: just `run()` — no fiber, no DO.
 *   - Cloudflare: `doInstance.runFiber('flue:workflow:<runId>', run)`.
 *
 * The caller is responsible for any logging on completion/error; this wrapper
 * starts durably admitted workflow execution for any supported observation mode.
 */
export type StartWorkflowAdmissionFn = (
	runId: string,
	run: () => Promise<unknown>,
) => Promise<unknown>;

export interface HandleAgentOptions {
	request: Request;
	id: string;
	agentName: string;
	eventStreamStore: EventStreamStore;
	admitAttachedSubmission: AttachedAgentSubmissionAdmission;
}

export interface HandleWorkflowOptions {
	request: Request;
	workflowName: string;
	workflow: WorkflowDefinition;
	createContext: CreateContextFn;
	startWorkflowAdmission?: StartWorkflowAdmissionFn;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
	runId?: string;
}

/**
 * Derive the absolute DS stream URL advertised in invocation responses from
 * the incoming request URL (query stripped). Agent prompts stream at the
 * request URL itself; workflow runs stream at the sibling `/runs/:runId`
 * route under the same mount prefix as the admitting `/workflows/:name`
 * route.
 */
function invocationStreamUrl(request: Request, runId?: string): string {
	const url = new URL(request.url);
	url.search = '';
	if (runId !== undefined) {
		const index = url.pathname.lastIndexOf('/workflows/');
		const prefix = index > 0 ? url.pathname.slice(0, index) : '';
		url.pathname = `${prefix}/runs/${encodeURIComponent(runId)}`;
	}
	return url.toString();
}

/**
 * Build the 202 admission response shared by agent and workflow invocation.
 * The stream coordinates are mirrored as `Location` and `Stream-Next-Offset`
 * headers, matching the Durable Streams stream-creation convention.
 */
function admissionResponse(
	body: Record<string, unknown>,
	streamUrl: string,
	offset: string,
): Response {
	return new Response(JSON.stringify(body), {
		status: 202,
		headers: {
			'content-type': 'application/json',
			Location: streamUrl,
			'Stream-Next-Offset': offset,
		},
	});
}

/**
 * Handle one attached `/agents/:name/:id` prompt interaction.
 *
 * Returns accepted stream coordinates by default, or a synchronous JSON
 * result when `?wait=result` is requested. Events are available via the DS
 * stream read endpoint (GET on the same URL).
 */
export async function handleAgentRequest(opts: HandleAgentOptions): Promise<Response> {
	const { request, id } = opts;

	try {
		const rawPayload = await parseJsonBody(request);
		const payload = parseDirectAgentPayload(rawPayload);
		const directOptions: DirectAttachedOptions = {
			payload,
			admitAttachedSubmission: opts.admitAttachedSubmission,
		};
		const streamUrl = invocationStreamUrl(request);
		// Stream creation is owned by the coordinator at first accepted prompt
		// (idempotent createStream before processing each claimed submission).
		// Creating it here would leave a phantom open stream behind when
		// admission fails, breaking the documented 404-until-first-prompt
		// contract for stream reads.
		const streamPath = agentStreamPath(opts.agentName, id);
		const offset = (await opts.eventStreamStore.getStreamMeta(streamPath))?.nextOffset ?? '-1';
		if (new URL(request.url).searchParams.get('wait') === 'result') {
			return runDirectSyncMode(directOptions, streamUrl, offset);
		}
		const receipt = await opts.admitAttachedSubmission(payload, undefined, false);
		return admissionResponse(
			{ streamUrl, offset, submissionId: receipt.submissionId },
			streamUrl,
			offset,
		);
	} catch (err) {
		return toHttpResponse(err);
	}
}

export async function handleWorkflowRequest(opts: HandleWorkflowOptions): Promise<Response> {
	const { request, workflowName, workflow, createContext, runStore, eventStreamStore } = opts;
	const startWorkflowAdmission = opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission;
	const runId = opts.runId ?? generateWorkflowRunId();

	try {
		const input = await parseJsonBody(request);
		parseActionInput(workflow.action, input);
		const wait = new URL(request.url).searchParams.get('wait');

		const execution = await prepareWorkflowExecution({
			workflowName,
			id: runId,
			runId,
			workflow,
			input,
			request,
			createContext,
			startWorkflowAdmission,
			runStore,
			eventStreamStore,
		});

		if (wait === 'result') return await runSyncMode(execution);
		return await runWorkflowAdmissionMode(execution);
	} catch (err) {
		return toHttpResponse(err);
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

export interface InvokeWorkflowAttachedOptions {
	workflowName: string;
	id: string;
	runId: string;
	workflow: WorkflowDefinition;
	input: unknown;
	request: Request;
	createContext: CreateContextFn;
	onEvent?: FlueEventCallback;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
}

export interface DirectAttachedOptions {
	payload: DirectAgentPayload;
	admitAttachedSubmission: AttachedAgentSubmissionAdmission;
	onEvent?: AttachedAgentEventCallback;
}

export interface WorkflowAttachedInvocationResult {
	runId: string;
	result: unknown;
}

export interface FailRecoveredRunOptions {
	workflowName: string;
	id: string;
	runId: string;
	request: Request;
	createContext: CreateContextFn;
	error: unknown;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
}

export interface AdmitDetachedWorkflowOptions {
	workflowName: string;
	workflow: WorkflowDefinition;
	input: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWorkflowAdmission?: StartWorkflowAdmissionFn;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
	runId?: string;
}

interface WorkflowAdmissionOptions {
	workflowName: string;
	id: string;
	runId: string;
	workflow: WorkflowDefinition;
	input: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWorkflowAdmission: StartWorkflowAdmissionFn;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
}

interface AdmittedWorkflowExecution {
	runId: string;
	/** Absolute DS stream URL for the run's event stream. */
	streamUrl: string;
	/** Stream offset captured at admission — reading from it yields the run's events from the start. */
	offset: string;
	runStore: RunStore;
	lifecycle: WorkflowRunLifecycle;
	startWorkflowAdmission: StartWorkflowAdmissionFn;
	workflow: WorkflowDefinition;
	completion?: Promise<unknown>;
	admission?: Promise<void>;
}

async function prepareWorkflowExecution(
	opts: WorkflowAdmissionOptions,
): Promise<AdmittedWorkflowExecution> {
	const {
		workflowName,
		id,
		runId,
		workflow,
		input,
		request,
		createContext,
		startWorkflowAdmission,
		runStore,
		eventStreamStore,
	} = opts;
	if (!runStore) throw new RunStoreUnavailableError();
	const lifecycle = await createWorkflowRunLifecycle({
		workflowName,
		id,
		runId,
		input,
		request,
		createContext,
		runStore,
		eventStreamStore,
		requirePersistedAdmission: true,
	});
	// Capture the stream coordinates at admission, before any run event is
	// appended, so reading from the returned offset replays the whole run.
	const offset = (await eventStreamStore.getStreamMeta(runStreamPath(runId)))?.nextOffset ?? '-1';
	return {
		runId,
		streamUrl: invocationStreamUrl(request, runId),
		offset,
		runStore,
		lifecycle,
		startWorkflowAdmission,
		workflow,
	};
}

function startWorkflowExecution(execution: AdmittedWorkflowExecution): Promise<void> {
	if (execution.admission) return execution.admission;
	const { runId, lifecycle, workflow, startWorkflowAdmission } = execution;
	let didRun = false;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const run = async (): Promise<unknown> => {
		didRun = true;
		markStarted();
		return await withWorkflowRunLifecycle(lifecycle, () =>
			executeWorkflowDefinition(workflow, lifecycle.ctx, lifecycle.input),
		);
	};
	try {
		execution.completion = Promise.resolve(startWorkflowAdmission(runId, run));
	} catch (error) {
		execution.admission = emitRunEnd(lifecycle, { isError: true, error }).then(() => {
			throw error;
		});
		return execution.admission;
	}
	const scheduling = execution.completion.then(
		() => undefined,
		async (error) => {
			if (didRun) return;
			await emitRunEnd(lifecycle, { isError: true, error });
			throw error;
		},
	);
	execution.admission = Promise.race([started, scheduling]);
	return execution.admission;
}

async function detachWorkflowExecution(execution: AdmittedWorkflowExecution): Promise<void> {
	const admission = startWorkflowExecution(execution);
	execution.completion?.catch((error) => {
		console.error('[flue] Workflow run failed:', execution.runId, error);
	});
	await admission;
}

export async function admitDetachedWorkflow(
	opts: AdmitDetachedWorkflowOptions,
): Promise<{ runId: string }> {
	const runId = opts.runId ?? generateWorkflowRunId();
	const execution = await prepareWorkflowExecution({
		workflowName: opts.workflowName,
		id: runId,
		runId,
		workflow: opts.workflow,
		input: opts.input,
		request: opts.request,
		createContext: opts.createContext,
		startWorkflowAdmission: opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission,
		runStore: opts.runStore,
		eventStreamStore: opts.eventStreamStore,
	});
	await detachWorkflowExecution(execution);
	return { runId };
}

async function runWorkflowAdmissionMode(execution: AdmittedWorkflowExecution): Promise<Response> {
	await detachWorkflowExecution(execution);
	return admissionResponse(
		{ runId: execution.runId, streamUrl: execution.streamUrl, offset: execution.offset },
		execution.streamUrl,
		execution.offset,
	);
}

export async function failRecoveredRun(opts: FailRecoveredRunOptions): Promise<void> {
	const events = await readRecoveryEvents(opts);
	const terminalEvent = findTerminalRunEvent(events);
	const run = await opts.runStore?.getRun(opts.runId);
	if (terminalEvent || (run && run.status !== 'active')) {
		await reconcileTerminalRun(opts, run, terminalEvent);
		return;
	}
	// Derive the next event index from the stream head, not the event count —
	// the count undercounts when the stream has gaps (a dropped append or a
	// crash mid-append), which would mint duplicate eventIndex values and
	// break seq == eventIndex for the recovery events.
	const meta = await opts.eventStreamStore.getStreamMeta(runStreamPath(opts.runId));
	const initialEventIndex = meta ? parseOffset(meta.nextOffset) + 1 : 0;
	const startedAt = run?.startedAt ?? new Date().toISOString();
	const startedAtMs = Date.parse(startedAt);
	const startEvent = events.find((event) => event.type === 'run_start');
	const input = run?.input !== undefined ? run.input : startEvent?.input;
	// The original workflow may have crashed before its admission write
	// landed. Idempotent first-writer-wins createRun makes the recovered run
	// visible so the terminal endRun below has a record to finalize.
	if (!run)
		await safeRunStore('createRun(recovery)', () =>
			opts.runStore?.createRun({
				runId: opts.runId,
				workflowName: opts.workflowName,
				startedAt,
				input,
			}),
		);
	// Ensure the event stream exists — the original workflow may have crashed
	// before createWorkflowRunLifecycle called createStream. Idempotent.
	await opts.eventStreamStore.createStream(runStreamPath(opts.runId));
	const lifecycle: WorkflowRunLifecycle = {
		...opts,
		input,
		ctx: opts.createContext(opts.id, opts.runId, opts.request, initialEventIndex),
		startedAt,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
	};
	const flushFanout = subscribeRunFanout(lifecycle);
	emitRunResume(lifecycle);
	await flushFanout();
	await emitRunEnd(lifecycle, { isError: true, error: opts.error });
}

async function readRecoveryEvents(opts: FailRecoveredRunOptions): Promise<FlueEvent[]> {
	const streamPath = runStreamPath(opts.runId);
	// Read all events — recovery needs the history to find a terminal
	// run_end and the run_start input fallback. The next event index is
	// derived from the stream head instead (gap-proof).
	const events: FlueEvent[] = [];
	let offset = '-1';
	while (true) {
		const result = await opts.eventStreamStore.readEvents(streamPath, { offset });
		for (const event of result.events) {
			events.push(normalizeRunStreamEvent(event.data));
		}
		if (result.upToDate || result.events.length === 0) break;
		offset = result.nextOffset;
	}
	return events;
}

async function reconcileTerminalRun(
	opts: FailRecoveredRunOptions,
	run: Awaited<ReturnType<RunStore['getRun']>> | undefined,
	terminalEvent: Extract<FlueEvent, { type: 'run_end' }> | undefined,
): Promise<void> {
	const isError = terminalEvent?.isError ?? run?.isError ?? false;
	const result = terminalEvent?.result !== undefined ? terminalEvent.result : run?.result;
	const error = terminalEvent?.error !== undefined ? terminalEvent.error : run?.error;
	const endedAt = terminalEvent?.timestamp ?? run?.endedAt ?? new Date().toISOString();
	const durationMs = terminalEvent?.durationMs ?? run?.durationMs ?? 0;
	if (terminalEvent && !run) {
		// Stream holds a terminal run_end but the record is missing — the
		// original admission write was lost. Idempotent createRun, then the
		// terminal endRun below repairs the record in cursor-safe order.
		await safeRunStore('createRun(recovery)', () =>
			opts.runStore?.createRun({
				runId: opts.runId,
				workflowName: opts.workflowName,
				startedAt: endedAt,
				input: undefined,
			}),
		);
	}
	if (terminalEvent && (!run || run.status === 'active')) {
		await opts.runStore?.endRun({
			runId: opts.runId,
			endedAt,
			isError,
			durationMs,
			result,
			error,
		});
	}
	// Ensure the event stream is closed so DS readers see EOF. A crash
	// between appendEvent(run_end) and closeStream() can leave the stream
	// permanently open without this repair.
	await opts.eventStreamStore.closeStream(runStreamPath(opts.runId));
}

export function normalizeRunStreamEvent(value: unknown): FlueEvent {
	if (!value || typeof value !== 'object') return value as FlueEvent;
	const event = value as Record<string, unknown>;
	if (event.type !== 'run_start' || 'input' in event || !('payload' in event)) {
		return value as FlueEvent;
	}
	const { payload, ...rest } = event;
	return { ...rest, input: payload } as FlueEvent;
}

function findTerminalRunEvent(
	events: FlueEvent[],
): Extract<FlueEvent, { type: 'run_end' }> | undefined {
	return [...events]
		.reverse()
		.find((event): event is Extract<FlueEvent, { type: 'run_end' }> => event.type === 'run_end');
}

async function runDirectSyncMode(
	opts: DirectAttachedOptions,
	streamUrl: string,
	offset: string,
): Promise<Response> {
	const receipt = await invokeDirectAttached(opts);
	return new Response(
		JSON.stringify({
			result: receipt.result === undefined ? null : receipt.result,
			streamUrl,
			offset,
			submissionId: receipt.submissionId,
		}),
		{
			headers: { 'content-type': 'application/json' },
		},
	);
}

export async function invokeDirectAttached(
	opts: DirectAttachedOptions,
): ReturnType<AttachedAgentSubmissionAdmission> {
	return opts.admitAttachedSubmission(opts.payload, opts.onEvent);
}

async function runSyncMode(execution: AdmittedWorkflowExecution): Promise<Response> {
	let result: unknown;
	try {
		await startWorkflowExecution(execution);
		result = await execution.completion;
	} catch (error) {
		await execution.completion?.catch(() => undefined);
		throw error;
	}
	return new Response(
		JSON.stringify({
			result: result === undefined ? null : result,
			runId: execution.runId,
			streamUrl: execution.streamUrl,
			offset: execution.offset,
		}),
		{ headers: { 'content-type': 'application/json' } },
	);
}

export async function invokeWorkflowAttached(
	opts: InvokeWorkflowAttachedOptions,
): Promise<WorkflowAttachedInvocationResult> {
	parseActionInput(opts.workflow.action, opts.input);
	const lifecycle = await createWorkflowRunLifecycle({
		workflowName: opts.workflowName,
		id: opts.id,
		runId: opts.runId,
		input: opts.input,
		request: opts.request,
		createContext: opts.createContext,
		runStore: opts.runStore,
		eventStreamStore: opts.eventStreamStore,
	});
	const { ctx } = lifecycle;
	if (opts.onEvent) {
		ctx.setEventCallback(opts.onEvent);
	}
	try {
		const result = await withWorkflowRunLifecycle(lifecycle, () =>
			executeWorkflowDefinition(opts.workflow, ctx, opts.input),
		);
		return { runId: opts.runId, result };
	} finally {
		ctx.setEventCallback(undefined);
	}
}

async function executeWorkflowDefinition(
	workflow: WorkflowDefinition,
	ctx: FlueContextInternal,
	input: unknown,
): Promise<unknown> {
	const parsedInput = parseActionInput(workflow.action, input);
	const harness = await ctx.initializeRootHarness(workflow.agent);
	try {
		return await runActionWithParsedInput(workflow.action, { harness, log: ctx.log }, parsedInput);
	} finally {
		await harness.close();
	}
}

// ─── Workflow run lifecycle ─────────────────────────────────────────────────

interface WorkflowRunLifecycleOptions {
	workflowName: string;
	id: string;
	runId: string;
	input: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	eventStreamStore: EventStreamStore;
	requirePersistedAdmission?: boolean;
}

interface WorkflowRunLifecycle extends WorkflowRunLifecycleOptions {
	ctx: FlueContextInternal;
	startedAt: string;
	startedAtMs: number;
}

async function createWorkflowRunLifecycle(
	options: WorkflowRunLifecycleOptions,
): Promise<WorkflowRunLifecycle> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const ctx = options.createContext(options.id, options.runId, options.request);
	const runStore = options.runStore;
	const workflowName = options.workflowName;
	try {
		if (runStore)
			await persistRunAdmission('createRun', options.requirePersistedAdmission === true, () =>
				runStore.createRun({
					runId: options.runId,
					workflowName,
					startedAt,
					input: options.input,
				}),
			);
	} catch (error) {
		console.error(
			'[flue] Workflow admission error:',
			{
				workflowName,
				runId: options.runId,
				operation: 'createRun',
				outcome: 'admission_failed',
			},
			error,
		);
		throw error;
	}
	try {
		await options.eventStreamStore.createStream(runStreamPath(options.runId));
	} catch (error) {
		if (runStore) {
			const endedAtMs = Date.now();
			await runStore.endRun({
				runId: options.runId,
				endedAt: new Date(endedAtMs).toISOString(),
				isError: true,
				durationMs: endedAtMs - startedAtMs,
				error: serializeError(error),
			});
		}
		throw error;
	}
	return { ...options, ctx, startedAt, startedAtMs };
}

/**
 * Wrap all workflow invocation modes with the same run-start/run-end envelope.
 */
async function withWorkflowRunLifecycle<T>(
	lifecycle: WorkflowRunLifecycle,
	body: () => T | Promise<T>,
): Promise<T> {
	const flushFanout = subscribeRunFanout(lifecycle);
	emitRunStart(lifecycle);
	let didFlushFanout = false;
	let result: T;
	try {
		result = await body();
		await flushFanout();
		didFlushFanout = true;
	} catch (error) {
		if (!didFlushFanout) {
			try {
				await flushFanout();
			} catch {}
		}
		await emitRunEnd(lifecycle, { isError: true, error });
		throw error;
	}
	await emitRunEnd(lifecycle, { result, isError: false });
	return result;
}

function emitRunStart(lifecycle: WorkflowRunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_start',
		runId: lifecycle.runId,
		workflowName: lifecycle.workflowName,
		startedAt: lifecycle.startedAt,
		input: lifecycle.input,
	});
}

function emitRunResume(lifecycle: WorkflowRunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_resume',
		runId: lifecycle.runId,
		workflowName: lifecycle.workflowName,
		startedAt: lifecycle.startedAt,
	});
}

/**
 * Emit `run_end` and finalize the run.
 *
 * Terminal ordering: append `run_end` to the event stream store and close it,
 * then persist the terminal record to the run store.
 */
async function emitRunEnd(
	lifecycle: WorkflowRunLifecycle,
	input: { result?: unknown; isError: false } | { isError: true; error: unknown },
): Promise<void> {
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - lifecycle.startedAtMs;
	const result = input.isError ? undefined : input.result;
	const error = input.isError ? serializeError(input.error) : undefined;
	const normalizedResult = result === undefined ? null : result;

	const { runStore, eventStreamStore, runId } = lifecycle;

	// Decorate through the shared event path so eventIndex/timestamp stay continuous.
	const decorated = lifecycle.ctx.emitEvent({
		type: 'run_end',
		runId,
		result: normalizedResult,
		isError: input.isError,
		error,
		durationMs,
	});

	// Append run_end to the durable event stream, then close it.
	// Each operation is individually guarded so a store failure cannot
	// prevent RunStore finalization below.
	try {
		await eventStreamStore.appendEvent(runStreamPath(runId), decorated);
	} catch (e) {
		console.error('[flue:event-stream] appendEvent(run_end) failed:', e);
	}
	try {
		await eventStreamStore.closeStream(runStreamPath(runId));
	} catch (e) {
		console.error('[flue:event-stream] closeStream failed:', e);
	}

	if (runStore)
		await safeRunStore('endRun', () =>
			runStore.endRun({
				runId,
				endedAt,
				isError: input.isError,
				durationMs,
				result: input.isError ? result : normalizedResult,
				error,
			}),
		);
}

const BUFFERED_EVENT_FLUSH_INTERVAL_MS = 3_000;

/**
 * Persist non-terminal events to the event stream store.
 * `run_end` is handled separately by {@link emitRunEnd}.
 *
 * Other events are appended immediately. Per-chunk streaming events (see
 * {@link isBufferedRunEvent}) are buffered and flushed at most once per
 * {@link BUFFERED_EVENT_FLUSH_INTERVAL_MS} to avoid
 * issuing one durable storage write per streamed chunk.
 *
 * Because `emitEvent` dispatches to subscribers synchronously (fire-and-forget),
 * async `appendEvent` calls produce floating promises. We collect them in a
 * buffer and drain at the returned flush function, which is awaited by
 * {@link withWorkflowRunLifecycle} after the workflow body completes.
 */
function subscribeRunFanout(lifecycle: WorkflowRunLifecycle): () => Promise<void> {
	const { ctx, eventStreamStore, runId } = lifecycle;
	const streamPath = runStreamPath(runId);
	const pending: Promise<void>[] = [];

	// ── Streaming event buffering ────────────────────────────────────────
	let bufferedEvents: FlueEvent[] = [];
	let bufferTimer: ReturnType<typeof setTimeout> | undefined;

	function flushBufferedEvents(): void {
		if (bufferedEvents.length === 0) return;
		const batch = bufferedEvents;
		bufferedEvents = [];
		for (const event of batch) {
			pending.push(
				eventStreamStore.appendEvent(streamPath, event).then(
					() => {},
					(error) => {
						console.error('[flue:event-stream] appendEvent failed:', error);
					},
				),
			);
		}
	}

	function scheduleBufferFlush(): void {
		if (bufferTimer !== undefined) return;
		bufferTimer = setTimeout(() => {
			bufferTimer = undefined;
			flushBufferedEvents();
		}, BUFFERED_EVENT_FLUSH_INTERVAL_MS);
	}

	// ── Subscription ────────────────────────────────────────────────────
	const unsubscribe = ctx.subscribeEvent((event) => {
		if (event.type === 'run_end') return;
		if (isStreamExcludedEvent(event)) return;
		if (isBufferedRunEvent(event)) {
			bufferedEvents.push(event);
			scheduleBufferFlush();
			return;
		}
		// Flush buffered streaming events first to preserve emission order.
		flushBufferedEvents();
		pending.push(
			eventStreamStore.appendEvent(streamPath, event).then(
				() => {},
				(error) => {
					console.error('[flue:event-stream] appendEvent failed:', error);
				},
			),
		);
	});

	return async () => {
		unsubscribe();
		if (bufferTimer !== undefined) {
			clearTimeout(bufferTimer);
			bufferTimer = undefined;
		}
		flushBufferedEvents();
		await Promise.all(pending);
	};
}

async function persistRunAdmission(
	label: string,
	required: boolean,
	fn: () => Promise<void> | undefined,
): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch (error) {
		console.error(`[flue:run-store] ${label} failed:`, error);
		if (required) throw error;
		return false;
	}
}

async function safeRunStore(label: string, fn: () => Promise<void> | undefined): Promise<boolean> {
	return persistRunAdmission(label, false, fn);
}

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return error;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Default background workflow runner: invoke `run()` directly so the workflow
 * executes in the current process. Used by the Node target. The Cloudflare
 * target overrides this with a `runFiber` wrapper for crash-recoverable
 * execution across DO hibernation.
 */
const defaultStartWorkflowAdmission: StartWorkflowAdmissionFn = (_runId, run) =>
	Promise.resolve().then(run);
