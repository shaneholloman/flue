import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	failRecoveredRun,
	InMemorySessionStore,
	invokeAttached,
	recoverAgentRun,
	reserveRecoveredAgentSession,
	registeredAgentsForChannel,
	registeredWorkflowsForChannel,
	type FlueRuntime,
} from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';

describe('WebSocket transport foundation', () => {
	it('admits HTTP and WebSocket channels independently', () => {
		const runtime: FlueRuntime = {
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'http-only', channels: { http: true }, receive: false, created: true },
					{ name: 'socket-only', channels: { websocket: true }, receive: false, created: true },
					{ name: 'dual', channels: { http: true, websocket: true }, receive: false, created: true },
				],
				workflows: [
					{ name: 'http-job', channels: { http: true } },
					{ name: 'socket-job', channels: { websocket: true } },
					{ name: 'dual-job', channels: { http: true, websocket: true } },
				],
			},
		};

		expect(registeredAgentsForChannel(runtime, 'http')).toEqual(['http-only', 'dual']);
		expect(registeredAgentsForChannel(runtime, 'websocket')).toEqual(['socket-only', 'dual']);
		expect(registeredWorkflowsForChannel(runtime, 'http')).toEqual(['http-job', 'dual-job']);
		expect(registeredWorkflowsForChannel(runtime, 'websocket')).toEqual(['socket-job', 'dual-job']);
	});

	it('preserves Node direct HTTP handler visibility without declaring WebSocket exposure', () => {
		const runtime: FlueRuntime = {
			target: 'node',
			handlers: { legacy: async () => null },
			manifest: {
				agents: [{ name: 'legacy', channels: {}, receive: false, created: true }],
			},
		};

		expect(registeredAgentsForChannel(runtime, 'http')).toContain('legacy');
		expect(registeredAgentsForChannel(runtime, 'websocket')).not.toContain('legacy');
	});

	it('does not admit WebSocket-only workflows through HTTP POST', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [], workflows: [{ name: 'socket-job', channels: { websocket: true } }] },
			workflowHandlers: { 'socket-job': async () => ({ ok: true }) },
			createContext: createContext,
		});
		const app = new Hono();
		app.route('/', flue());

		const response = await app.fetch(new Request('http://localhost/workflows/socket-job', { method: 'POST' }));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { type: 'workflow_not_http' } });
	});

	it('forwards Cloudflare upgrades only for WebSocket-exposed targets and normalizes mounted paths', async () => {
		const forwarded: string[] = [];
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: {
				agents: [
					{ name: 'assistant', channels: { websocket: true }, receive: false, created: true },
					{ name: 'http-agent', channels: { http: true }, receive: false, created: true },
				],
				workflows: [
					{ name: 'job', channels: { websocket: true } },
					{ name: 'http-job', channels: { http: true } },
				],
			},
			routeAgentRequest: async (request) => {
				forwarded.push(new URL(request.url).pathname);
				return Response.json({ ok: true });
			},
			routeWorkflowRequest: async (request, _env, target) => {
				forwarded.push(`${new URL(request.url).pathname}:${target.instanceId}`);
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.route('/api', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/api/workflows/job', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/api/agents/http-agent/one', upgrade))).status).toBe(404);
		expect((await app.fetch(new Request('http://localhost/api/workflows/http-job', upgrade))).status).toBe(404);
		expect(forwarded[0]).toBe('/agents/assistant/one');
		expect(forwarded[1]).toMatch(/^\/workflows\/job:workflow:job:/);
	});

	it('runs Cloudflare custom app middleware before a mounted socket upgrade is forwarded', async () => {
		let forwarded = false;
		configureFlueRuntime({
			target: 'cloudflare',
			manifest: { agents: [{ name: 'assistant', channels: { websocket: true }, receive: false, created: true }] },
			routeAgentRequest: async () => {
				forwarded = true;
				return Response.json({ ok: true });
			},
		});
		const app = new Hono();
		app.use('/api/agents/*', async (c, next) => {
			if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401);
			await next();
		});
		app.route('/api', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one', upgrade))).status).toBe(401);
		expect(forwarded).toBe(false);
		expect((await app.fetch(new Request('http://localhost/api/agents/assistant/one?token=ok', upgrade))).status).toBe(200);
		expect(forwarded).toBe(true);
	});

	it('rejects concurrent attached prompts to the same agent session', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = {
			owner: { kind: 'agent' as const, agentName: 'assistant', instanceId: 'user-1' },
			id: 'user-1',
			payload: { message: 'hello', session: 'chat' },
			request: new Request('http://localhost/agents/assistant/user-1', { method: 'POST' }),
			createContext,
		};
		const first = invokeAttached({
			...base,
			runId: 'run_first',
			handler: async () => {
				await pending;
				return null;
			},
		});
		await expect(invokeAttached({
			...base,
			runId: 'run_second',
			handler: async () => null,
		})).rejects.toMatchObject({ details: 'This agent session already has an active prompt.' });
		release?.();
		await first;
	});

	it('rejects HTTP webhook prompts while the same agent session is active', async () => {
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		configureFlueRuntime({
			target: 'node',
			manifest: { agents: [{ name: 'assistant', channels: { http: true }, receive: false, created: true }] },
			handlers: {
				assistant: async () => {
					await pending;
					return null;
				},
			},
			createContext,
		});
		const app = new Hono();
		app.route('/', flue());
		const first = await app.fetch(new Request('http://localhost/agents/assistant/user-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-webhook': 'true' },
			body: JSON.stringify({ message: 'first', session: 'chat' }),
		}));
		expect(first.status).toBe(202);
		const second = await app.fetch(new Request('http://localhost/agents/assistant/user-1', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message: 'second', session: 'chat' }),
		}));
		expect(second.status).toBe(400);
		expect(await second.json()).toMatchObject({ error: { type: 'invalid_request', details: 'This agent session already has an active prompt.' } });
		release?.();
	});

	it('continues a recovered webhook run without duplicating its run start', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'user-1' };
		const runId = 'run_recovered';
		const startedAt = new Date(Date.now() - 50).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });
		await runStore.appendEvent(runId, {
			type: 'run_start',
			runId,
			owner,
			instanceId: owner.instanceId,
			agentName: owner.agentName,
			startedAt,
			payload: { message: 'hello' },
			eventIndex: 0,
			timestamp: startedAt,
		});

		const result = await recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/agents/assistant/user-1', { method: 'POST' }),
			createContext,
			handler: async (ctx) => {
				ctx.log.info('recovered');
				return { ok: true };
			},
			runStore,
			runRegistry,
		});

		expect(result).toEqual({ result: { ok: true }, isError: false });
		const events = await runStore.getEvents(runId);
		expect(events.map((event) => event.type)).toEqual(['run_start', 'log', 'run_end']);
		expect(events.map((event) => event.eventIndex)).toEqual([0, 1, 2]);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', result: { ok: true } });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});

	it('honors an agent session reservation acquired before recovered work begins', async () => {
		const runStore = new InMemoryRunStore();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'reserved-user' };
		const runId = 'run_reserved_recovered';
		const payload = { message: 'hello', session: 'chat' };
		await runStore.createRun({ runId, owner, startedAt: new Date().toISOString(), payload });
		const releaseSessionLock = reserveRecoveredAgentSession(owner, payload);

		await expect(invokeAttached({
			owner,
			id: owner.instanceId,
			runId: 'run_newer',
			payload,
			request: new Request('http://localhost/agents/assistant/reserved-user', { method: 'POST' }),
			createContext,
			handler: async () => null,
		})).rejects.toMatchObject({ details: 'This agent session already has an active prompt.' });

		const recovered = await recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload,
			request: new Request('http://localhost/agents/assistant/reserved-user', { method: 'POST' }),
			createContext,
			handler: async () => ({ ok: true }),
			releaseSessionLock,
			runStore,
		});

		expect(recovered).toEqual({ result: { ok: true }, isError: false });
	});

	it('does not release a newer session reservation from an older recovery owner', async () => {
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'token-user' };
		const payload = { message: 'hello', session: 'chat' };
		const releaseOld = reserveRecoveredAgentSession(owner, payload);
		releaseOld?.();
		const releaseNew = reserveRecoveredAgentSession(owner, payload);
		releaseOld?.();

		await expect(invokeAttached({
			owner,
			id: owner.instanceId,
			runId: 'run_overlapping',
			payload,
			request: new Request('http://localhost/agents/assistant/token-user', { method: 'POST' }),
			createContext,
			handler: async () => null,
		})).rejects.toMatchObject({ details: 'This agent session already has an active prompt.' });

		releaseNew?.();
	});

	it('finalizes a recovered run that already persisted run_end without invoking work again', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'user-1' };
		const runId = 'run_terminal_recovered';
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });
		await runRegistry.recordRunStart({ runId, owner, startedAt });
		await runStore.appendEvent(runId, {
			type: 'run_end',
			runId,
			result: { ok: true },
			isError: false,
			durationMs: 50,
			eventIndex: 1,
			timestamp: new Date(Date.now() - 50).toISOString(),
		});
		let invoked = false;

		const result = await recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/agents/assistant/user-1', { method: 'POST' }),
			createContext,
			handler: async () => {
				invoked = true;
				return null;
			},
			runStore,
			runRegistry,
		});

		expect(result).toEqual({ result: { ok: true }, isError: false, error: undefined });
		expect(invoked).toBe(false);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', result: { ok: true } });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});

	it('repairs missing registry state when the durable run already completed before recovery', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'user-1' };
		const runId = 'run_registry_recovered';
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });
		await runStore.endRun({
			runId,
			endedAt: new Date(Date.now() - 50).toISOString(),
			isError: false,
			durationMs: 50,
			result: { ok: true },
		});
		let invoked = false;

		const result = await recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/agents/assistant/user-1', { method: 'POST' }),
			createContext,
			handler: async () => {
				invoked = true;
				return null;
			},
			runStore,
			runRegistry,
		});

		expect(result).toEqual({ result: { ok: true }, isError: false, error: undefined });
		expect(invoked).toBe(false);
		expect((await runStore.getEvents(runId)).map((event) => event.type)).toEqual(['run_end']);
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});

	it('retains errored terminal status when reconciling an interrupted run', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'user-error' };
		const runId = 'run_error_recovered';
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });
		await runStore.appendEvent(runId, {
			type: 'run_end',
			runId,
			isError: true,
			error: { message: 'failed' },
			durationMs: 50,
			eventIndex: 1,
			timestamp: new Date(Date.now() - 50).toISOString(),
		});

		const result = await recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/agents/assistant/user-error', { method: 'POST' }),
			createContext,
			handler: async () => null,
			runStore,
			runRegistry,
		});

		expect(result).toMatchObject({ isError: true, error: { message: 'failed' } });
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'errored' });
	});

	it('persists an errored terminal run when recovery setup throws', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'broken' };
		const runId = 'run_broken_recovered';
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });

		await expect(recoverAgentRun({
			label: 'assistant',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/agents/assistant/broken', { method: 'POST' }),
			createContext: () => {
				throw new Error('context failed');
			},
			handler: async () => null,
			runStore,
			runRegistry,
		})).rejects.toThrow('context failed');
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'errored' });
	});

	it('persists an errored terminal run when recovery cannot continue', async () => {
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const owner = { kind: 'workflow' as const, workflowName: 'removed', instanceId: 'workflow:removed:one' };
		const runId = owner.instanceId;
		const startedAt = new Date(Date.now() - 100).toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload: { message: 'hello' } });

		await failRecoveredRun({
			label: 'removed',
			owner,
			id: owner.instanceId,
			runId,
			payload: { message: 'hello' },
			request: new Request('http://localhost/workflows/removed', { method: 'POST' }),
			createContext,
			error: new Error('Handler unavailable'),
			restartedAsRunId: 'workflow:removed:replacement',
			runStore,
			runRegistry,
		});

		const events = await runStore.getEvents(runId);
		expect(events.map((event) => event.type)).toEqual(['run_end']);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'errored', isError: true, restartedAsRunId: 'workflow:removed:replacement' });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'errored' });
	});

	it('invokes attached work with an event sink independent of HTTP response formatting', async () => {
		const events: FlueEvent[] = [];
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'workflow:daily-report:test';
		const request = new Request('http://localhost/workflows/daily-report', {
			headers: { upgrade: 'websocket' },
		});

		const invocation = await invokeAttached({
			owner: { kind: 'workflow', workflowName: 'daily-report', instanceId: runId },
			id: runId,
			runId,
			payload: { day: 'today' },
			restartedFromRunId: 'workflow:daily-report:previous',
			request,
			createContext,
			handler: async (ctx) => {
				expect(ctx.req).toBe(request);
				ctx.log.info('running');
				return { echoed: ctx.payload };
			},
			onEvent: (event) => {
				events.push(event);
			},
			emitIdleOnComplete: true,
			runStore,
			runRegistry,
		});

		expect(invocation).toEqual({ runId, result: { echoed: { day: 'today' } } });
		expect(events.map((event) => event.type)).toEqual(['run_start', 'log', 'idle', 'run_end']);
		expect(events.every((event) => event.runId === runId)).toBe(true);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', restartedFromRunId: 'workflow:daily-report:previous', result: { echoed: { day: 'today' } } });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});
});

function createContext(id: string, runId: string, payload: unknown, req: Request, initialEventIndex?: number) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		initialEventIndex,
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
