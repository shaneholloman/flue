import { describe, expect, it } from 'vitest';
import {
	connectCloudflareAgentWebSocket,
	connectCloudflareWorkflowWebSocket,
	messageCloudflareAgentWebSocket,
	messageCloudflareWorkflowWebSocket,
	type CloudflareWebSocketConnection,
} from '../src/cloudflare/websocket.ts';
import { createFlueContext, InMemoryRunRegistry, InMemoryRunStore, InMemorySessionStore } from '../src/internal.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

describe('Cloudflare WebSocket transport', () => {
	it('keeps agent sockets open across sequential prompts', async () => {
		const connection = new TestConnection();
		connectCloudflareAgentWebSocket(connection, { name: 'assistant', id: 'instance-1', requestUrl: 'https://example.com/agents/assistant/instance-1' });
		const options = agentOptions();

		await messageCloudflareAgentWebSocket(connection, JSON.stringify({ version: 1, type: 'prompt', requestId: 'one', message: 'first', session: 'chat' }), options);
		await messageCloudflareAgentWebSocket(connection, JSON.stringify({ version: 1, type: 'prompt', requestId: 'two', message: 'second' }), options);

		expect(connection.messages[0]).toMatchObject({ type: 'ready', target: 'agent', name: 'assistant', instanceId: 'instance-1' });
		expect(connection.messages.find((message) => message.type === 'result' && message.requestId === 'one')).toMatchObject({ result: { message: 'first', session: 'chat' } });
		expect(connection.messages.find((message) => message.type === 'result' && message.requestId === 'two')).toMatchObject({ result: { message: 'second' } });
		expect(connection.closed).toBeUndefined();
	});

	it('returns structured invalid-message errors without closing agent sockets', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(connection, '{', agentOptions());

		expect(connection.messages).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ type: 'invalid_request' }) }));
		expect(connection.closed).toBeUndefined();
	});

	it('rejects Agents SDK reserved inbound messages as invalid Flue protocol messages', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(connection, JSON.stringify({ type: 'cf_agent_state', state: { tampered: true } }), agentOptions());

		expect(connection.messages).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ type: 'invalid_request' }) }));
	});

	it('closes sockets before invoking oversized messages', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(connection, JSON.stringify({ version: 1, type: 'prompt', requestId: 'large', message: 'x'.repeat(1024 * 1024) }), agentOptions());

		expect(connection.messages).toContainEqual(expect.objectContaining({ type: 'error', error: expect.objectContaining({ type: 'invalid_request' }) }));
		expect(connection.closed).toEqual({ code: 1008, reason: 'Message too large' });
	});

	it('does not fail an invocation when a disconnected socket rejects delivery', async () => {
		const connection = new TestConnection();
		connection.rejectSends = true;
		await messageCloudflareAgentWebSocket(connection, JSON.stringify({ version: 1, type: 'prompt', requestId: 'gone', message: 'continue' }), agentOptions());
		expect(connection.closed).toBeUndefined();
	});

	it('runs one workflow invocation and closes normally after its result', async () => {
		const connection = new TestConnection();
		connectCloudflareWorkflowWebSocket(connection, { name: 'job', runId: 'workflow:job:test', requestUrl: 'https://example.com/workflows/job' });
		await messageCloudflareWorkflowWebSocket(connection, JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-1', payload: { ok: true } }), {
			name: 'job',
			runId: 'workflow:job:test',
			request: new Request('https://example.com/workflows/job'),
			handler: async (ctx) => ctx.payload,
			createContext,
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
		});

		expect(connection.messages[0]).toMatchObject({ type: 'ready', target: 'workflow', name: 'job' });
		expect(connection.messages).toContainEqual(expect.objectContaining({ type: 'result', requestId: 'work-1', result: { ok: true } }));
		expect(connection.closed).toEqual({ code: 1000, reason: 'Workflow completed' });
	});
});

class TestConnection implements CloudflareWebSocketConnection {
	attachment = null as ReturnType<CloudflareWebSocketConnection['deserializeAttachment']>;
	messages: WebSocketServerMessage[] = [];
	closed: { code?: number; reason?: string } | undefined;
	rejectSends = false;

	serializeAttachment(attachment: NonNullable<typeof this.attachment>): void {
		this.attachment = attachment;
	}

	deserializeAttachment() {
		return this.attachment;
	}

	send(message: string): void {
		if (this.rejectSends) throw new Error('socket closed');
		this.messages.push(JSON.parse(message) as WebSocketServerMessage);
	}

	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
}

function agentOptions() {
	return {
		name: 'assistant',
		id: 'instance-1',
		request: new Request('https://example.com/agents/assistant/instance-1'),
		handler: async (ctx: { payload: unknown }) => ctx.payload,
		createContext,
		runStore: new InMemoryRunStore(),
		runRegistry: new InMemoryRunRegistry(),
	};
}

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
