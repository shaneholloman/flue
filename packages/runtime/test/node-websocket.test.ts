import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createFlueContext, InMemoryRunRegistry, InMemoryRunStore, InMemorySessionStore } from '../src/internal.ts';
import { createNodeWebSocketTransport, type NodeWebSocketTransport } from '../src/node/index.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of closeCallbacks.splice(0)) await close();
});

describe('Node WebSocket transport', () => {
	it('keeps agent sockets open across sequential prompts', async () => {
		const { socket, messages } = await startAgentSocket();
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(JSON.stringify({ version: 1, type: 'prompt', requestId: 'one', message: 'first', session: 'chat' }));
		const first = await waitForMessage(messages, (message) => message.type === 'result' && message.requestId === 'one');
		expect(first).toMatchObject({ result: { message: 'first', session: 'chat' } });

		socket.send(JSON.stringify({ version: 1, type: 'prompt', requestId: 'two', message: 'second' }));
		const second = await waitForMessage(messages, (message) => message.type === 'result' && message.requestId === 'two');
		expect(second).toMatchObject({ result: { message: 'second' } });
		expect(messages.filter((message) => message.type === 'started')).toHaveLength(2);
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it('returns structured errors for invalid agent messages without closing the socket', async () => {
		const { socket, messages } = await startAgentSocket();
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send('{');
		const error = await waitForMessage(messages, (message) => message.type === 'error');
		expect(error).toMatchObject({ error: { type: 'invalid_request' } });
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it('terminates server sockets after transport-level errors', async () => {
		const { socket, transport } = await startAgentSocket();
		const accepted = [...transport.server.clients][0];
		if (!accepted) throw new Error('Expected accepted server socket.');
		accepted.emit('error', new Error('transport failed'));
		await new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
		expect(transport.server.clients.size).toBe(0);
	});
});

async function startAgentSocket(): Promise<{ socket: WebSocket; messages: WebSocketServerMessage[]; transport: NodeWebSocketTransport }> {
	const transport = createTransport();
	const app = new Hono();
	app.get('/agents/:name/:id', transport.agentRoute);
	const server = serve({ fetch: app.fetch, websocket: { server: transport.server }, port: 0 });
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected test server address.');
	const socket = new WebSocket(`ws://localhost:${address.port}/agents/assistant/instance-1`);
	const messages = collectMessages(socket);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), { once: true });
	});
	closeCallbacks.push(async () => {
		if (socket.readyState === WebSocket.OPEN) {
			await new Promise<void>((resolve) => {
				socket.addEventListener('close', () => resolve(), { once: true });
				socket.close();
			});
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { socket, messages, transport };
}

function createTransport(): NodeWebSocketTransport {
	return createNodeWebSocketTransport({
		manifest: {
			agents: [{ name: 'assistant', channels: { websocket: true }, receive: false, created: true }],
		},
		agentHandlers: {
			assistant: async (ctx) => ctx.payload,
		},
		workflowHandlers: {},
		createContext: (id, runId, payload, req) => createFlueContext({
			id,
			runId,
			payload,
			req,
			env: {},
			agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
			createDefaultEnv: async () => ({}) as never,
			defaultStore: new InMemorySessionStore(),
		}),
		runStore: new InMemoryRunStore(),
		runRegistry: new InMemoryRunRegistry(),
	});
}

function collectMessages(socket: WebSocket): WebSocketServerMessage[] {
	const messages: WebSocketServerMessage[] = [];
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as WebSocketServerMessage);
	});
	return messages;
}

async function waitForMessage(
	messages: WebSocketServerMessage[],
	predicate: (message: WebSocketServerMessage) => boolean,
): Promise<WebSocketServerMessage> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const message = messages.find(predicate);
		if (message) return message;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}
