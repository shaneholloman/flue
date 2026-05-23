import { InvalidRequestError } from '../errors.ts';
import type { AgentWebSocketClientMessage, WebSocketServerMessage, WorkflowWebSocketClientMessage } from '../types.ts';
import type { AgentHandler, CreateContextFn, RunHandlerFn, WorkflowHandler } from '../runtime/handle-agent.ts';
import { invokeAttached } from '../runtime/handle-agent.ts';
import { generateRunId } from '../runtime/ids.ts';
import type { RunRegistry } from '../runtime/run-registry.ts';
import type { RunStore } from '../runtime/run-store.ts';
import type { RunSubscriberRegistry } from '../runtime/run-subscribers.ts';
import {
	createWebSocketErrorMessage,
	parseAgentWebSocketMessage,
	parseWorkflowWebSocketMessage,
} from '../runtime/websocket-protocol.ts';

export type CloudflareWebSocketAttachment =
	| { version: 1; target: 'agent'; name: string; id: string; requestUrl: string }
	| { version: 1; target: 'workflow'; name: string; runId: string; requestUrl: string; invoked: boolean };

export interface CloudflareWebSocketConnection {
	serializeAttachment(value: CloudflareWebSocketAttachment): void;
	deserializeAttachment(): CloudflareWebSocketAttachment | null;
	send(message: string): void;
	close(code?: number, reason?: string): void;
}

interface CloudflareAttachedOptions {
	request: Request;
	createContext: CreateContextFn;
	runHandler?: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

export interface CloudflareAgentWebSocketOptions extends CloudflareAttachedOptions {
	name: string;
	id: string;
	handler: AgentHandler;
}

export interface CloudflareWorkflowWebSocketOptions extends CloudflareAttachedOptions {
	name: string;
	runId: string;
	handler: WorkflowHandler;
}

type SocketMessage = string | ArrayBuffer | ArrayBufferView;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export function connectCloudflareAgentWebSocket(
	connection: CloudflareWebSocketConnection,
	options: Pick<CloudflareAgentWebSocketOptions, 'name' | 'id'> & { requestUrl: string },
): void {
	connection.serializeAttachment({ version: 1, target: 'agent', name: options.name, id: options.id, requestUrl: options.requestUrl });
	send(connection, { version: 1, type: 'ready', target: 'agent', name: options.name, instanceId: options.id });
}

export function connectCloudflareWorkflowWebSocket(
	connection: CloudflareWebSocketConnection,
	options: Pick<CloudflareWorkflowWebSocketOptions, 'name' | 'runId'> & { requestUrl: string },
): void {
	connection.serializeAttachment({ version: 1, target: 'workflow', name: options.name, runId: options.runId, requestUrl: options.requestUrl, invoked: false });
	send(connection, { version: 1, type: 'ready', target: 'workflow', name: options.name });
}

export async function messageCloudflareAgentWebSocket(
	connection: CloudflareWebSocketConnection,
	raw: SocketMessage,
	options: CloudflareAgentWebSocketOptions,
): Promise<void> {
	if (typeof raw !== 'string') {
		sendError(connection, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
		close(connection, 1003, 'Binary messages are not supported');
		return;
	}
	if (messageBytes(raw) > MAX_MESSAGE_BYTES) {
		sendError(connection, new InvalidRequestError({ reason: 'WebSocket messages must not exceed 1048576 bytes.' }));
		close(connection, 1008, 'Message too large');
		return;
	}
	let message: AgentWebSocketClientMessage;
	try {
		message = parseAgentWebSocketMessage(raw);
	} catch (error) {
		sendError(connection, error);
		return;
	}
	if (message.type === 'ping') {
		send(connection, { version: 1, type: 'pong', requestId: message.requestId });
		return;
	}
	await invokeAgentPrompt(connection, message, options);
}

export async function messageCloudflareWorkflowWebSocket(
	connection: CloudflareWebSocketConnection,
	raw: SocketMessage,
	options: CloudflareWorkflowWebSocketOptions,
): Promise<void> {
	if (typeof raw !== 'string') {
		sendError(connection, new InvalidRequestError({ reason: 'Binary WebSocket messages are not supported.' }));
		close(connection, 1003, 'Binary messages are not supported');
		return;
	}
	if (messageBytes(raw) > MAX_MESSAGE_BYTES) {
		sendError(connection, new InvalidRequestError({ reason: 'WebSocket messages must not exceed 1048576 bytes.' }));
		close(connection, 1008, 'Message too large');
		return;
	}
	let message: WorkflowWebSocketClientMessage;
	try {
		message = parseWorkflowWebSocketMessage(raw);
	} catch (error) {
		sendError(connection, error);
		return;
	}
	const attachment = connection.deserializeAttachment();
	if (!attachment || attachment.target !== 'workflow' || attachment.invoked) {
		sendError(connection, new InvalidRequestError({ reason: 'Workflow WebSocket connections accept one invocation only.' }), message.requestId);
		close(connection, 1008, 'Workflow accepts one invocation only');
		return;
	}
	connection.serializeAttachment({ ...attachment, invoked: true });
	await invokeWorkflow(connection, message, options);
}

async function invokeAgentPrompt(
	connection: CloudflareWebSocketConnection,
	message: Extract<AgentWebSocketClientMessage, { type: 'prompt' }>,
	options: CloudflareAgentWebSocketOptions,
): Promise<void> {
	const runId = generateRunId();
	let didStart = false;
	try {
		const invocation = await invokeAttached({
			owner: { kind: 'agent', agentName: options.name, instanceId: options.id },
			id: options.id,
			runId,
			payload: { message: message.message, session: message.session },
			request: options.request,
			handler: options.handler,
			createContext: options.createContext,
			runHandler: options.runHandler,
			onEvent: (event) => {
				if (!didStart) {
					didStart = true;
					send(connection, { version: 1, type: 'started', requestId: message.requestId, runId });
				}
				send(connection, { version: 1, type: 'event', requestId: message.requestId, runId, event });
			},
			emitIdleOnComplete: true,
			runStore: options.runStore,
			runSubscribers: options.runSubscribers,
			runRegistry: options.runRegistry,
		});
		send(connection, { version: 1, type: 'result', requestId: message.requestId, runId, result: invocation.result ?? null });
	} catch (error) {
		sendError(connection, error, message.requestId, didStart ? runId : undefined);
	}
}

async function invokeWorkflow(
	connection: CloudflareWebSocketConnection,
	message: WorkflowWebSocketClientMessage,
	options: CloudflareWorkflowWebSocketOptions,
): Promise<void> {
	send(connection, { version: 1, type: 'started', requestId: message.requestId, runId: options.runId });
	try {
		const invocation = await invokeAttached({
			owner: { kind: 'workflow', workflowName: options.name, instanceId: options.runId },
			id: options.runId,
			runId: options.runId,
			payload: message.payload,
			request: options.request,
			handler: options.handler,
			createContext: options.createContext,
			runHandler: options.runHandler,
			onEvent: (event) => send(connection, { version: 1, type: 'event', requestId: message.requestId, runId: options.runId, event }),
			emitIdleOnComplete: true,
			runStore: options.runStore,
			runSubscribers: options.runSubscribers,
			runRegistry: options.runRegistry,
		});
		send(connection, { version: 1, type: 'result', requestId: message.requestId, runId: options.runId, result: invocation.result ?? null });
		close(connection, 1000, 'Workflow completed');
	} catch (error) {
		sendError(connection, error, message.requestId, options.runId);
		close(connection, 1011, 'Workflow failed');
	}
}

function messageBytes(message: string): number {
	return new TextEncoder().encode(message).byteLength;
}

function sendError(connection: CloudflareWebSocketConnection, error: unknown, requestId?: string, runId?: string): void {
	send(connection, createWebSocketErrorMessage(error, requestId, runId));
}

function send(connection: CloudflareWebSocketConnection, message: WebSocketServerMessage): void {
	try {
		connection.send(JSON.stringify(message));
	} catch {
		return;
	}
}

function close(connection: CloudflareWebSocketConnection, code: number, reason: string): void {
	try {
		connection.close(code, reason);
	} catch {
		return;
	}
}
