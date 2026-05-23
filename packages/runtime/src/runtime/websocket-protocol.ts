import { InvalidRequestError, toPublicError } from '../errors.ts';
import type { AgentWebSocketClientMessage, WebSocketServerMessage, WorkflowWebSocketClientMessage } from '../types.ts';

export function parseAgentWebSocketMessage(raw: string): AgentWebSocketClientMessage {
	const value = parseObject(raw);
	if (value.version !== 1 || (value.type !== 'prompt' && value.type !== 'ping')) {
		throw new InvalidRequestError({ reason: 'Agent WebSocket messages must use protocol version 1 and type "prompt" or "ping".' });
	}
	if (value.type === 'ping') {
		if (value.requestId !== undefined && typeof value.requestId !== 'string') {
			throw new InvalidRequestError({ reason: 'Agent WebSocket ping requestId must be a string when provided.' });
		}
		return { version: 1, type: 'ping', requestId: value.requestId as string | undefined };
	}
	if (typeof value.requestId !== 'string' || value.requestId === '' || typeof value.message !== 'string') {
		throw new InvalidRequestError({ reason: 'Agent WebSocket prompt messages require string requestId and message values.' });
	}
	if (value.session !== undefined && (typeof value.session !== 'string' || value.session.trim() === '')) {
		throw new InvalidRequestError({ reason: 'Agent WebSocket prompt session must be a non-empty string when provided.' });
	}
	return { version: 1, type: 'prompt', requestId: value.requestId, message: value.message, session: value.session as string | undefined };
}

export function parseWorkflowWebSocketMessage(raw: string): WorkflowWebSocketClientMessage {
	const value = parseObject(raw);
	if (value.version !== 1 || value.type !== 'invoke' || typeof value.requestId !== 'string' || value.requestId === '') {
		throw new InvalidRequestError({ reason: 'Workflow WebSocket messages require protocol version 1, type "invoke", and a string requestId.' });
	}
	return { version: 1, type: 'invoke', requestId: value.requestId, payload: value.payload };
}

export function createWebSocketErrorMessage(error: unknown, requestId?: string, runId?: string): WebSocketServerMessage {
	return { version: 1, type: 'error', requestId, runId, error: toPublicError(error) };
}

function parseObject(raw: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new InvalidRequestError({ reason: 'WebSocket messages must be valid JSON objects.' });
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new InvalidRequestError({ reason: 'WebSocket messages must be valid JSON objects.' });
	}
	return value as Record<string, unknown>;
}
