import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { flue } from '../src/app.ts';
import {
	configureFlueRuntime,
	createDirectAgentHandler,
	createFlueContext,
	createRunSubscriberRegistry,
	InMemoryDispatchQueue,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	recoverAgentRun,
} from '../src/internal.ts';
import { createAgent } from '../src/agent-definition.ts';
import { Harness } from '../src/harness.ts';
import type { AgentConfig, FlueHarness, FlueSession, SessionData, SessionEnv, SessionStore } from '../src/types.ts';

describe('direct attached agent delivery', () => {
	it('routes direct HTTP through init and the default session without receive or dispatch', async () => {
		const initCalls: string[] = [];
		const prompts: Array<{ session: string; message: string }> = [];
		const receiveCalls: string[] = [];
		const dispatches: unknown[] = [];

		const agent = createAgent(({ id, payload }) => {
			initCalls.push(`${id}:${String(payload)}`);
			return { model: false };
		});
		const initialize = (id: string, runId: string, payload: unknown, req: Request) => {
			const ctx = createTestContext(id, runId, payload, req);
			ctx.initializeCreatedAgent = async (created, agentPayload) => {
				await created.initialize({ id: ctx.id, env: {}, payload: agentPayload });
				return fakeHarness(prompts);
			};
			return ctx;
		};

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, created: true }],
			},
			handlers: { assistant: createDirectAgentHandler(agent) },
			receiveHandlers: {
				assistant: async ({ delivery }) => receiveCalls.push(delivery.id),
			},
			dispatchQueue: new InMemoryDispatchQueue({
				process(input) {
					dispatches.push(input);
				},
			}),
			createContext: initialize,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(res.status).toBe(200);
		expect((await res.json()) as unknown).toMatchObject({ result: { text: 'reply:hello' } });
		expect(initCalls).toEqual(['inst-1:undefined']);
		expect(prompts).toEqual([{ session: 'default', message: 'hello' }]);
		expect(receiveCalls).toEqual([]);
		expect(dispatches).toEqual([]);
	});

	it('routes direct HTTP to a supplied session', async () => {
		const prompts: Array<{ session: string; message: string }> = [];

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, created: true }],
			},
			handlers: { assistant: createDirectAgentHandler(createAgent(() => ({ model: false }))) },
			createContext: createFakeContext(prompts),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello', session: 'case:123' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(prompts).toEqual([{ session: 'case:123', message: 'hello' }]);
	});

	it('persists direct input before inference and reuses it during recovery', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness('inst-1', 'default', testAgentConfig(), fakeEnv(), store);
		const session = await harness.session('case:123');
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[] };
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		let continuations = 0;
		agent.continue = async () => {
			continuations++;
			const admitted = await store.load('agent-session:["inst-1","default","case:123"]');
			expect(admitted?.entries).toEqual([
				expect.objectContaining({ source: 'prompt', direct: { runId: 'run-direct' } }),
			]);
			agent.state.messages.push({
				role: 'assistant',
				content: [{ type: 'text', text: 'processed' }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as AgentMessage);
		};
		agent.waitForIdle = async () => {};

		const direct = session as FlueSession & { processDirectInput(input: { runId: string; message: string }): PromiseLike<unknown> };
		await direct.processDirectInput({ runId: 'run-direct', message: 'hello' });
		await direct.processDirectInput({ runId: 'run-direct', message: 'hello' });

		const data = await store.load('agent-session:["inst-1","default","case:123"]');
		expect(continuations).toBe(1);
		expect(data?.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
		expect(data?.entries[0]).toMatchObject({ direct: { runId: 'run-direct' } });
	});

	it('retries an uncommitted side effect while recovering admitted direct input', async () => {
		const store = new InMemorySessionStore();
		const runStore = new InMemoryRunStore();
		const runRegistry = new InMemoryRunRegistry();
		const runId = 'run-side-effect';
		const payload = { message: 'hello', session: 'case:123' };
		const owner = { kind: 'agent' as const, agentName: 'assistant', instanceId: 'inst-side-effect' };
		const startedAt = new Date().toISOString();
		await runStore.createRun({ runId, owner, startedAt, payload });
		await runStore.appendEvent(runId, {
			type: 'run_start',
			runId,
			owner,
			instanceId: owner.instanceId,
			agentName: owner.agentName,
			startedAt,
			payload,
			eventIndex: 0,
			timestamp: startedAt,
		});
		let sideEffects = 0;
		const interruptedHarness = new Harness(owner.instanceId, 'default', testAgentConfig(), fakeEnv(), store);
		const interruptedSession = await interruptedHarness.session(payload.session);
		const interruptedAgent = Reflect.get(interruptedSession, 'harness') as {
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		interruptedAgent.continue = async () => {
			sideEffects++;
			throw new Error('simulated Durable Object reset');
		};
		interruptedAgent.waitForIdle = async () => {};
		const interrupted = interruptedSession as FlueSession & { processDirectInput(input: { runId: string; message: string }): PromiseLike<unknown> };
		await expect(interrupted.processDirectInput({ runId, message: payload.message })).rejects.toThrow('simulated Durable Object reset');

		const recoveredHarness = new Harness(owner.instanceId, 'default', testAgentConfig(), fakeEnv(), store);
		const recoveredSession = await recoveredHarness.session(payload.session);
		const recoveredAgent = Reflect.get(recoveredSession, 'harness') as {
			state: { messages: AgentMessage[] };
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		recoveredAgent.continue = async () => {
			sideEffects++;
			recoveredAgent.state.messages.push({
				role: 'assistant',
				content: [{ type: 'text', text: 'processed' }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as AgentMessage);
		};
		recoveredAgent.waitForIdle = async () => {};
		const recovered = recoveredSession as FlueSession & { processDirectInput(input: { runId: string; message: string }): PromiseLike<unknown> };

		const result = await recoverAgentRun({
			label: owner.agentName,
			owner,
			id: owner.instanceId,
			runId,
			payload,
			request: new Request(`http://localhost/agents/assistant/${owner.instanceId}`, { method: 'POST' }),
			createContext: createTestContext,
			handler: async () => recovered.processDirectInput({ runId, message: payload.message }),
			runStore,
			runRegistry,
		});

		const data = await store.load(`agent-session:["${owner.instanceId}","default","${payload.session}"]`);
		const events = await runStore.getEvents(runId);
		expect(result).toMatchObject({ isError: false });
		expect(sideEffects).toBe(2);
		expect(data?.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1);
		expect(data?.entries[0]).toMatchObject({ direct: { runId } });
		expect(events.map((event) => event.type)).toEqual(['run_start', 'run_end']);
		expect(await runStore.getRun(runId)).toMatchObject({ status: 'completed' });
	});

	it('does not complete recovery from a persisted errored assistant turn', async () => {
		const store = new InMemorySessionStore();
		const harness = new Harness('inst-error', 'default', testAgentConfig(), fakeEnv(), store);
		const session = await harness.session();
		const agent = Reflect.get(session, 'harness') as {
			state: { messages: AgentMessage[]; errorMessage?: string };
			continue: () => Promise<void>;
			waitForIdle: () => Promise<void>;
		};
		let continuations = 0;
		agent.continue = async () => {
			continuations++;
			agent.state.messages.push({
				role: 'assistant',
				content: [{ type: 'text', text: '' }],
				stopReason: 'error',
				errorMessage: 'provider failed',
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as AgentMessage);
			agent.state.errorMessage = 'provider failed';
		};
		agent.waitForIdle = async () => {};
		const direct = session as FlueSession & { processDirectInput(input: { runId: string; message: string }): PromiseLike<unknown> };

		await expect(direct.processDirectInput({ runId: 'run-error', message: 'hello' })).rejects.toThrow('provider failed');
		agent.state.errorMessage = undefined;
		await expect(direct.processDirectInput({ runId: 'run-error', message: 'hello' })).rejects.toThrow('provider failed');
		expect(continuations).toBe(1);
	});

	it('keeps external-channel agents directly addressable', async () => {
		const prompts: Array<{ session: string; message: string }> = [];

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'moderator', channels: { discord: true }, receive: true, created: true }],
			},
			handlers: { moderator: createDirectAgentHandler(createAgent(() => ({ model: false }))) },
			receiveHandlers: {
				moderator: async () => {
					throw new Error('receive should not run for direct HTTP');
				},
			},
			createContext: createFakeContext(prompts),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/moderator/guild-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'check this' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(prompts).toEqual([{ session: 'default', message: 'check this' }]);
	});

	it('keeps SSE streaming behavior for direct HTTP callers', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, created: true }],
			},
			handlers: { assistant: createDirectAgentHandler(createAgent(() => ({ model: false }))) },
			createContext: createFakeContext([]),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
			runSubscribers: createRunSubscriberRegistry(),
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const stream = await res.text();
		expect(stream).toContain('event: run_start');
		expect(stream).toContain('event: idle');
		expect(stream).toContain('event: run_end');
	});

	it('rejects non-provisional direct payload shapes clearly', async () => {
		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, created: true }],
			},
			handlers: { assistant: createDirectAgentHandler(createAgent(() => ({ model: false }))) },
			createContext: createTestContext,
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: 'wrong' }),
			}),
		);

		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toMatchObject({ error: { type: 'invalid_request' } });
	});

	it('passes the target instance id into created-agent sandbox factories', async () => {
		const sandboxCalls: Array<{ id: string; cwd?: string }> = [];
		const prompts: Array<{ session: string; message: string }> = [];
		const store = new RecordingSessionStore();

		configureFlueRuntime({
			target: 'node',
			manifest: {
				agents: [{ name: 'assistant', channels: {}, receive: false, created: true }],
			},
			handlers: {
				assistant: createDirectAgentHandler(createAgent(() => ({
					profile: { model: false },
					cwd: '/workspace',
					persist: store,
					sandbox: {
						async createSessionEnv(options) {
							sandboxCalls.push(options);
							return fakeEnv();
						},
					},
				}))),
			},
			createContext: createTestContext,
		});

		const app = new Hono();
		app.route('/', flue());

		const res = await app.fetch(
			new Request('http://localhost/agents/assistant/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hello' }),
			}),
		);

		expect(res.status).toBe(500);
		expect(sandboxCalls).toEqual([{ id: 'inst-1', cwd: '/workspace' }]);
		expect(store.loadCalls).toContain('agent-session:["inst-1","default","default"]');
		expect(prompts).toEqual([]);
	});
});

function fakeHarness(prompts: Array<{ session: string; message: string }>): FlueHarness {
	return {
		name: 'default',
		session: async (name?: string) => fakeSession(name ?? 'default', prompts),
		sessions: {} as never,
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
	};
}

function fakeSession(session: string, prompts: Array<{ session: string; message: string }>): FlueSession & { processDirectInput(input: { message: string }): PromiseLike<unknown> } {
	return {
		name: session,
		prompt: (() => Promise.resolve({ text: '', usage: {}, model: { id: 'test' } })) as never,
		processDirectInput: ({ message }: { message: string }) => {
			prompts.push({ session, message });
			return Promise.resolve({ text: `reply:${message}`, usage: {}, model: { id: 'test' } });
		},
		shell: (() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })) as never,
		fs: {} as never,
		skill: (() => Promise.resolve({ text: '', usage: {}, model: { id: 'test' } })) as never,
		task: (() => Promise.resolve({ text: '', usage: {}, model: { id: 'test' } })) as never,
		compact: async () => {},
		delete: async () => {},
	};
}

function createFakeContext(prompts: Array<{ session: string; message: string }>) {
	return (id: string, runId: string, payload: unknown, req: Request) => {
		const ctx = createTestContext(id, runId, payload, req);
		ctx.initializeCreatedAgent = async (agent, agentPayload) => {
			await agent.initialize({ id, env: {}, payload: agentPayload });
			return fakeHarness(prompts);
		};
		return ctx;
	};
}

function createTestContext(id: string, runId: string, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}

function testAgentConfig(): AgentConfig {
	return {
		systemPrompt: '',
		skills: {},
		subagents: {},
		model: { id: 'test-model', provider: 'test', api: 'test' } as never,
		resolveModel: () => ({ id: 'test-model', provider: 'test', api: 'test' }) as never,
	};
}

function fakeEnv(): SessionEnv {
	return {
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date() }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
		cwd: '/',
		resolvePath: (path) => path,
	};
}

class RecordingSessionStore implements SessionStore {
	readonly loadCalls: string[] = [];
	async save(_id: string, _data: SessionData): Promise<void> {}
	async load(id: string): Promise<SessionData | null> {
		this.loadCalls.push(id);
		return null;
	}
	async delete(_id: string): Promise<void> {}
}
