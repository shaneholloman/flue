import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	invokeAttached,
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

	it('forwards Cloudflare upgrades only for WebSocket-exposed targets', async () => {
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
		app.route('/', flue());
		const upgrade = { method: 'GET', headers: { upgrade: 'websocket' } };

		expect((await app.fetch(new Request('http://localhost/agents/assistant/one', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/workflows/job', upgrade))).status).toBe(200);
		expect((await app.fetch(new Request('http://localhost/agents/http-agent/one', upgrade))).status).toBe(404);
		expect((await app.fetch(new Request('http://localhost/workflows/http-job', upgrade))).status).toBe(404);
		expect(forwarded[0]).toBe('/agents/assistant/one');
		expect(forwarded[1]).toMatch(/^\/workflows\/job:workflow:job:/);
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
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed', result: { echoed: { day: 'today' } } });
		expect(await runRegistry.lookupRun(runId)).toMatchObject({ status: 'completed' });
	});
});

function createContext(id: string, runId: string, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
