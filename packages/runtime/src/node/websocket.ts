import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { InvalidRequestError } from '../errors.ts';
import type {
	AgentWebSocketClientMessage,
	WebSocketServerMessage,
	WorkflowWebSocketClientMessage,
} from '../types.ts';
import type { FlueManifest, FlueRuntime } from '../runtime/flue-app.ts';
import { registeredAgentsForChannel, registeredWorkflowsForChannel } from '../runtime/flue-app.ts';
import type { AgentHandler, CreateContextFn, RunHandlerFn, WorkflowHandler } from '../runtime/handle-agent.ts';
import { invokeAttached } from '../runtime/handle-agent.ts';
import { generateRunId, generateWorkflowRunId } from '../runtime/ids.ts';
import type { RunRegistry } from '../runtime/run-registry.ts';
import {
	createWebSocketErrorMessage,
	parseAgentWebSocketMessage,
	parseWorkflowWebSocketMessage,
} from '../runtime/websocket-protocol.ts';
import type { RunStore } from '../runtime/run-store.ts';
import type { RunSubscriberRegistry } from '../runtime/run-subscribers.ts';

export interface NodeWebSocketTransportOptions {
	manifest: FlueManifest;
	agentHandlers: Record<string, AgentHandler>;
	workflowHandlers: Record<string, WorkflowHandler>;
	maxPayload?: number;
	createContext: CreateContextFn;
	runHandler?: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

export interface NodeWebSocketTransport {
	attach(server: Server): void;
	close(): Promise<void>;
}

type SocketTarget =
	| { kind: 'agent'; name: string; id: string; handler: AgentHandler }
	| { kind: 'workflow'; name: string; handler: WorkflowHandler };

export function createNodeWebSocketTransport(options: NodeWebSocketTransportOptions): NodeWebSocketTransport {
	const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 1024 * 1024 });
	const runtime: FlueRuntime = { target: 'node', manifest: options.manifest };
	const agents = new Set(registeredAgentsForChannel(runtime, 'websocket'));
	const workflows = new Set(registeredWorkflowsForChannel(runtime, 'websocket'));
	let attachedServer: Server | undefined;
	const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const target = resolveSocketTarget(request, agents, workflows, options);
		if (!target) {
			rejectUpgrade(socket);
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			ws.on('error', () => {
				if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
			});
			if (target.kind === 'agent') handleAgentSocket(ws, request, target, options);
			else handleWorkflowSocket(ws, request, target, options);
		});
	};
	return {
		attach(server) {
			if (attachedServer) throw new Error('[flue] Node WebSocket transport is already attached.');
			attachedServer = server;
			server.on('upgrade', upgrade);
		},
		async close() {
			if (attachedServer) attachedServer.off('upgrade', upgrade);
			for (const socket of wss.clients) socket.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		},
	};
}

function resolveSocketTarget(
	request: IncomingMessage,
	agents: Set<string>,
	workflows: Set<string>,
	options: NodeWebSocketTransportOptions,
): SocketTarget | undefined {
	const segments = parseSegments(request.url);
	if (segments[0] === 'agents' && segments.length === 3) {
		const name = segments[1];
		const id = segments[2];
		const handler = name ? options.agentHandlers[name] : undefined;
		if (name && id && handler && agents.has(name)) return { kind: 'agent', name, id, handler };
	}
	if (segments[0] === 'workflows' && segments.length === 2) {
		const name = segments[1];
		const handler = name ? options.workflowHandlers[name] : undefined;
		if (name && handler && workflows.has(name)) return { kind: 'workflow', name, handler };
	}
	return undefined;
}

function parseSegments(pathname: string | undefined): string[] {
	try {
		return new URL(pathname ?? '/', 'http://localhost').pathname
			.split('/')
			.filter(Boolean)
			.map((part) => decodeURIComponent(part));
	} catch {
		return [];
	}
}

function rejectUpgrade(socket: Duplex): void {
	socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
	socket.destroy();
}

function handleAgentSocket(
	socket: WebSocket,
	request: IncomingMessage,
	target: Extract<SocketTarget, { kind: 'agent' }>,
	options: NodeWebSocketTransportOptions,
): void {
	send(socket, { version: 1, type: 'ready', target: 'agent', name: target.name, instanceId: target.id });
	socket.on('message', (raw, isBinary) => {
		if (isBinary) {
			sendError(socket, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
			socket.close(1003, 'Binary messages are not supported');
			return;
		}
		let message: AgentWebSocketClientMessage;
		try {
			message = parseAgentWebSocketMessage(raw.toString());
		} catch (error) {
			sendError(socket, error);
			return;
		}
		if (message.type === 'ping') {
			send(socket, { version: 1, type: 'pong', requestId: message.requestId });
			return;
		}
		void invokeAgentPrompt(socket, request, target, message, options);
	});
}

async function invokeAgentPrompt(
	socket: WebSocket,
	request: IncomingMessage,
	target: Extract<SocketTarget, { kind: 'agent' }>,
	message: Extract<AgentWebSocketClientMessage, { type: 'prompt' }>,
	options: NodeWebSocketTransportOptions,
): Promise<void> {
	const runId = generateRunId();
	let didStart = false;
	try {
		const invocation = await invokeAttached({
			owner: { kind: 'agent', agentName: target.name, instanceId: target.id },
			id: target.id,
			runId,
			payload: { message: message.message, session: message.session },
			request: toRequest(request),
			handler: target.handler,
			createContext: options.createContext,
			runHandler: options.runHandler,
			onEvent: (event) => {
				if (!didStart) {
					didStart = true;
					send(socket, { version: 1, type: 'started', requestId: message.requestId, runId });
				}
				send(socket, { version: 1, type: 'event', requestId: message.requestId, runId, event });
			},
			emitIdleOnComplete: true,
			runStore: options.runStore,
			runSubscribers: options.runSubscribers,
			runRegistry: options.runRegistry,
		});
		send(socket, { version: 1, type: 'result', requestId: message.requestId, runId, result: invocation.result ?? null });
	} catch (error) {
		sendError(socket, error, message.requestId, didStart ? runId : undefined);
	}
}

function handleWorkflowSocket(
	socket: WebSocket,
	request: IncomingMessage,
	target: Extract<SocketTarget, { kind: 'workflow' }>,
	options: NodeWebSocketTransportOptions,
): void {
	let invoked = false;
	send(socket, { version: 1, type: 'ready', target: 'workflow', name: target.name });
	socket.on('message', (raw, isBinary) => {
		if (isBinary) {
			sendError(socket, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
			socket.close(1003, 'Binary messages are not supported');
			return;
		}
		let message: WorkflowWebSocketClientMessage;
		try {
			message = parseWorkflowWebSocketMessage(raw.toString());
		} catch (error) {
			sendError(socket, error);
			return;
		}
		if (invoked) {
			sendError(socket, new InvalidRequestError({ reason: 'Workflow WebSocket connections accept one invocation only.' }), message.requestId);
			socket.close(1008, 'Workflow accepts one invocation only');
			return;
		}
		invoked = true;
		void invokeWorkflow(socket, request, target, message, options);
	});
}

async function invokeWorkflow(
	socket: WebSocket,
	request: IncomingMessage,
	target: Extract<SocketTarget, { kind: 'workflow' }>,
	message: WorkflowWebSocketClientMessage,
	options: NodeWebSocketTransportOptions,
): Promise<void> {
	const runId = generateWorkflowRunId(target.name);
	send(socket, { version: 1, type: 'started', requestId: message.requestId, runId });
	try {
		const invocation = await invokeAttached({
			owner: { kind: 'workflow', workflowName: target.name, instanceId: runId },
			id: runId,
			runId,
			payload: message.payload,
			request: toRequest(request),
			handler: target.handler,
			createContext: options.createContext,
			runHandler: options.runHandler,
			onEvent: (event) => send(socket, { version: 1, type: 'event', requestId: message.requestId, runId, event }),
			emitIdleOnComplete: true,
			runStore: options.runStore,
			runSubscribers: options.runSubscribers,
			runRegistry: options.runRegistry,
		});
		send(socket, { version: 1, type: 'result', requestId: message.requestId, runId, result: invocation.result ?? null });
		socket.close(1000, 'Workflow completed');
	} catch (error) {
		sendError(socket, error, message.requestId, runId);
		socket.close(1011, 'Workflow failed');
	}
}

function toRequest(request: IncomingMessage): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const host = request.headers.host ?? 'localhost';
	return new Request(new URL(request.url ?? '/', `http://${host}`), { method: 'GET', headers });
}

function sendError(socket: WebSocket, error: unknown, requestId?: string, runId?: string): void {
	send(socket, createWebSocketErrorMessage(error, requestId, runId));
}

function send(socket: WebSocket, message: WebSocketServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
