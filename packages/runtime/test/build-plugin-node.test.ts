import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext, BuildPlugin } from '../../cli/src/lib/types.ts';
import type { WebSocketServerMessage } from '../src/types.ts';

describe('Node build plugin', () => {
	it('derives route metadata from imported agent and workflow modules', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain("import * as handler_triage_0 from '/tmp/triage.ts'");
		expect(entry).toContain("import * as workflow_daily_report_0 from '/tmp/daily-report.ts'");
		expect(entry).toContain('const workflowHandlers = {};');
		expect(entry).toContain('const websocketAgentHandlers = {};');
		expect(entry).toContain('const websocketWorkflowHandlers = {};');
		expect(entry).toContain('const normalized = normalizeBuiltModules(agentModules, workflowModules);');
		expect(entry).not.toContain('channelModules');
	});

	it('starts a generated server and invokes an HTTP workflow', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-server-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
		fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
		fs.writeFileSync(
			path.join(root, 'workflows', 'smoke.ts'),
			`import { http } from '@flue/runtime';\n` +
				`export const channels = [http()];\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const port = await findAvailablePort();
		const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
		});
		try {
			await waitForServer(child, port);
			const response = await fetch(`http://localhost:${port}/workflows/smoke?wait=result`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { ok: true } });
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('invokes a WebSocket-only workflow without exposing HTTP POST', async () => {
		const root = createFixtureRoot('flue-websocket-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'socket-job.ts'),
			`import { websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export async function run(ctx) { ctx.log.info('socket run'); return { echoed: ctx.payload }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/workflows/socket-job`, { method: 'POST' });
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/workflows/socket-job`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'req-1', payload: { ok: true } }));
			const result = await waitForMessage(messages, (message) => message.type === 'result');
			expect(result).toMatchObject({ type: 'result', requestId: 'req-1', result: { echoed: { ok: true } } });
			expect(messages.some((message) => message.type === 'ready')).toBe(true);
			expect(messages.some((message) => message.type === 'started')).toBe(true);
			expect(messages.some((message) => message.type === 'event' && message.event.type === 'run_start')).toBe(true);
			await waitForClose(socket);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects WebSocket upgrades for HTTP-only workflows', async () => {
		const root = createFixtureRoot('flue-http-only-workflow-');
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'http-job.ts'),
			`import { http } from '@flue/runtime';\n` +
				`export const channels = [http()];\n` +
				`export async function run() { return { ok: true }; }\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const socket = new WebSocket(`ws://localhost:${port}/workflows/http-job`);
			const failure = await waitForSocketFailure(socket);
			expect(failure).toBe(true);
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('accepts agent WebSocket connections and ping frames independently of HTTP', async () => {
		const root = createFixtureRoot('flue-websocket-agent-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent, websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const http = await fetch(`http://localhost:${port}/agents/assistant/instance-1`, { method: 'POST' });
			expect(http.status).toBe(404);
			const socket = new WebSocket(`ws://localhost:${port}/agents/assistant/instance-1`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			const ready = await waitForMessage(messages, (message) => message.type === 'ready');
			expect(ready).toMatchObject({ type: 'ready', target: 'agent', name: 'assistant', instanceId: 'instance-1' });
			socket.send(JSON.stringify({ version: 1, type: 'ping', requestId: 'ping-1' }));
			const pong = await waitForMessage(messages, (message) => message.type === 'pong');
			expect(pong).toMatchObject({ type: 'pong', requestId: 'ping-1' });
			socket.close();
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('routes mounted custom-app WebSockets through middleware', async () => {
		const root = createFixtureRoot('flue-custom-app-websocket-');
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`import { createAgent, websocket } from '@flue/runtime';\n` +
				`export const channels = [websocket()];\n` +
				`export default createAgent(() => ({ model: false }));\n`,
		);
		fs.writeFileSync(
			path.join(root, 'app.ts'),
			`import { flue } from '@flue/runtime/app';\n` +
				`import { Hono } from 'hono';\n` +
				`const app = new Hono();\n` +
				`app.use('/api/agents/*', async (c, next) => { if (c.req.query('token') !== 'ok') return c.text('Unauthorized', 401); await next(); });\n` +
				`app.route('/api', flue());\n` +
				`export default app;\n`,
		);
		await build({ root, target: 'node' });

		const { child, port } = await startGeneratedServer(root);
		try {
			const rejected = new WebSocket(`ws://localhost:${port}/api/agents/assistant/instance-1`);
			expect(await waitForSocketFailure(rejected)).toBe(true);
			const socket = new WebSocket(`ws://localhost:${port}/api/agents/assistant/instance-1?token=ok`);
			const messages = collectMessages(socket);
			await waitForOpen(socket);
			const ready = await waitForMessage(messages, (message) => message.type === 'ready');
			expect(ready).toMatchObject({ target: 'agent', name: 'assistant', instanceId: 'instance-1' });
			socket.close();
		} finally {
			child.kill('SIGTERM');
		}
	});

	it('rejects duplicate agent basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-duplicate-agents-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), 'export default createAgent(() => ({ model: false }));\n');
		fs.writeFileSync(path.join(root, 'agents', 'assistant.js'), 'export default createAgent(() => ({ model: false }));\n');

		await expect(build({ root, target: 'node' })).rejects.toThrow('Duplicate agent basename "assistant"');
	});

	it('allows workflow exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-workflow-extra-exports-'));
		fs.mkdirSync(path.join(root, 'workflows'));
		fs.writeFileSync(
			path.join(root, 'workflows', 'draft.ts'),
			`export interface DraftPayload { message: string }\n` +
				`export type DraftResult = { ok: boolean }\n` +
				`export const schema = { type: 'object' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export async function run() { return { ok: true }; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('allows agent exports unrelated to Flue entrypoints', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-agent-extra-exports-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'assistant.ts'),
			`export interface AssistantPayload { message: string }\n` +
				`export const metadata = { owner: 'test' };\n` +
				`export function helper() { return 'helper'; }\n` +
				`export default { __flueCreatedAgent: true, initialize: async () => ({ model: false }) };\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).resolves.toEqual({ changed: true });
	});

	it('rejects legacy default-export agents with triggers using a migration message', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-legacy-agent-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(
			path.join(root, 'agents', 'draft.ts'),
			`export const triggers = { webhook: true };\n` +
				`export default async function handler() { return 'ok'; }\n`,
		);

		await expect(build({ root, plugin: parserOnlyPlugin })).rejects.toThrow('Found legacy 0.7 agent');
	});
});

const parserOnlyPlugin: BuildPlugin = {
	name: 'parser-only',
	bundle: 'none',
	entryFilename: 'server.mjs',
	generateEntryPoint() {
		return 'export default {};\n';
	},
};

function createFixtureRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	return root;
}

async function startGeneratedServer(root: string): Promise<{ child: ChildProcess; port: number }> {
	const port = await findAvailablePort();
	const child = spawn('node', [path.join(root, 'dist', 'server.mjs')], {
		cwd: root,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, PORT: String(port), FLUE_MODE: 'local' },
	});
	await waitForServer(child, port);
	return { child, port };
}

function collectMessages(socket: WebSocket): WebSocketServerMessage[] {
	const messages: WebSocketServerMessage[] = [];
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as WebSocketServerMessage);
	});
	return messages;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) return;
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), { once: true });
	});
}

async function waitForClose(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
}

async function waitForSocketFailure(socket: WebSocket): Promise<boolean> {
	return new Promise((resolve) => {
		socket.addEventListener('open', () => resolve(false), { once: true });
		socket.addEventListener('error', () => resolve(true), { once: true });
	});
}

async function waitForMessage(
	messages: WebSocketServerMessage[],
	predicate: (message: WebSocketServerMessage) => boolean,
): Promise<WebSocketServerMessage> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const found = messages.find(predicate);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}

async function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, () => {
			const address = server.address();
			if (address && typeof address === 'object') {
				server.close(() => resolve(address.port));
				return;
			}
			server.close(() => reject(new Error('Could not determine port')));
		});
		server.on('error', reject);
	});
}

async function waitForServer(child: ChildProcess, port: number): Promise<void> {
	let output = '';
	child.stderr?.on('data', (chunk) => {
		output += chunk.toString();
	});
	child.stdout?.on('data', (chunk) => {
		output += chunk.toString();
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (child.exitCode !== null) {
			throw new Error(`Generated server exited before listening:\n${output}`);
		}
		try {
			const response = await fetch(`http://localhost:${port}/runs/not-found`);
			await response.text();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error(`Generated server did not begin listening:\n${output}`);
}

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'triage', filePath: '/tmp/triage.ts', hasChannels: true, attachedChannels: {}, hasReceive: true, hasDefaultAgent: true }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts', hasChannels: true, attachedChannels: {} }],
		manifest: {
			agents: [{ name: 'triage', channels: {}, receive: true, created: true }],
			workflows: [{ name: 'daily-report', channels: {} }],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'node' },
	};
}
