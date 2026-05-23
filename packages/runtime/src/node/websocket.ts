import { upgradeWebSocket } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import type { WSContext } from 'hono/ws';
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
	server: WebSocketServer;
	agentRoute: MiddlewareHandler;
	workflowRoute: MiddlewareHandler;
	close(): Promise<void>;
}

type SocketTarget =
	| { kind: 'agent'; name: string; id: string; handler: AgentHandler }
	| { kind: 'workflow'; name: string; handler: WorkflowHandler };

type RoutedSocket = WSContext<WebSocket>;

export function createNodeWebSocketTransport(options: NodeWebSocketTransportOptions): NodeWebSocketTransport {
	installErrorEvent();
	const server = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? 1024 * 1024 });
	const runtime: FlueRuntime = { target: 'node', manifest: options.manifest };
	const agents = new Set(registeredAgentsForChannel(runtime, 'websocket'));
	const workflows = new Set(registeredWorkflowsForChannel(runtime, 'websocket'));
	const agentRoute = upgradeWebSocket((c) => {
		const name = c.req.param('name') ?? '';
		const id = c.req.param('id') ?? '';
		const handler = options.agentHandlers[name];
		if (!agents.has(name) || !id || !handler) throw new Error('[flue] Node runtime is missing WebSocket agent handler configuration.');
		const target: Extract<SocketTarget, { kind: 'agent' }> = { kind: 'agent', name, id, handler };
		const request = c.req.raw;
		return {
			onOpen: (_event, socket) => openAgentSocket(socket, target),
			onMessage: (event, socket) => receiveAgentMessage(socket, request, target, event.data, options),
			onError: (_event, socket) => terminateSocket(socket),
		};
	});
	const workflowRoute = upgradeWebSocket((c) => {
		const name = c.req.param('name') ?? '';
		const handler = options.workflowHandlers[name];
		if (!workflows.has(name) || !handler) throw new Error('[flue] Node runtime is missing WebSocket workflow handler configuration.');
		const target: Extract<SocketTarget, { kind: 'workflow' }> = { kind: 'workflow', name, handler };
		const request = c.req.raw;
		let invoked = false;
		return {
			onOpen: (_event, socket) => openWorkflowSocket(socket, target),
			onMessage: (event, socket) => {
				if (typeof event.data !== 'string') {
					sendError(socket, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
					socket.close(1003, 'Binary messages are not supported');
					return;
				}
				let message: WorkflowWebSocketClientMessage;
				try {
					message = parseWorkflowWebSocketMessage(event.data);
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
			},
			onError: (_event, socket) => terminateSocket(socket),
		};
	});
	return {
		server,
		agentRoute,
		workflowRoute,
		async close() {
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function openAgentSocket(socket: RoutedSocket, target: Extract<SocketTarget, { kind: 'agent' }>): void {
	send(socket, { version: 1, type: 'ready', target: 'agent', name: target.name, instanceId: target.id });
}

function receiveAgentMessage(
	socket: RoutedSocket,
	request: Request,
	target: Extract<SocketTarget, { kind: 'agent' }>,
	raw: string | Blob | ArrayBufferLike,
	options: NodeWebSocketTransportOptions,
): void {
	if (typeof raw !== 'string') {
		sendError(socket, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
		socket.close(1003, 'Binary messages are not supported');
		return;
	}
	let message: AgentWebSocketClientMessage;
	try {
		message = parseAgentWebSocketMessage(raw);
	} catch (error) {
		sendError(socket, error);
		return;
	}
	if (message.type === 'ping') {
		send(socket, { version: 1, type: 'pong', requestId: message.requestId });
		return;
	}
	void invokeAgentPrompt(socket, request, target, message, options);
}

async function invokeAgentPrompt(
	socket: RoutedSocket,
	request: Request,
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
			request,
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

function openWorkflowSocket(socket: RoutedSocket, target: Extract<SocketTarget, { kind: 'workflow' }>): void {
	send(socket, { version: 1, type: 'ready', target: 'workflow', name: target.name });
}

async function invokeWorkflow(
	socket: RoutedSocket,
	request: Request,
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
			request,
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

function installErrorEvent(): void {
	if (typeof (globalThis as { ErrorEvent?: unknown }).ErrorEvent !== 'undefined') return;
	class NodeErrorEvent extends Event {
		readonly error: unknown;

		constructor(type: string, init?: { error?: unknown }) {
			super(type);
			this.error = init?.error;
		}
	}
	Object.defineProperty(globalThis, 'ErrorEvent', { configurable: true, value: NodeErrorEvent });
}

function terminateSocket(socket: RoutedSocket): void {
	socket.raw?.terminate();
}

function sendError(socket: RoutedSocket, error: unknown, requestId?: string, runId?: string): void {
	send(socket, createWebSocketErrorMessage(error, requestId, runId));
}

function send(socket: RoutedSocket, message: WebSocketServerMessage): void {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
