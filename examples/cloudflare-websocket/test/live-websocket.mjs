import assert from 'node:assert/strict';

const baseUrl = new URL(process.env.FLUE_WS_BASE_URL ?? 'http://localhost:3584');
baseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';

await assertAgentPing('/api/agents/chat/live-test?token=live-test');
await assertRejected('/api/agents/chat/live-test');
await assertRejected('/api/workflows/live-smoke');
await assertWorkflow('/api/workflows/live-smoke?token=live-test');

async function assertRejected(pathname) {
	const socket = new WebSocket(new URL(pathname, baseUrl));
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Expected ${pathname} to reject the socket upgrade.`)), 10000);
		socket.addEventListener('open', () => {
			clearTimeout(timeout);
			socket.close();
			reject(new Error(`Expected ${pathname} to reject the socket upgrade.`));
		}, { once: true });
		socket.addEventListener('error', () => {
			clearTimeout(timeout);
			resolve();
		}, { once: true });
	});
}

async function assertAgentPing(pathname) {
	const { socket, messages } = await connect(pathname, (message) => message.type === 'ready');
	assert.deepEqual(messages[0], { version: 1, type: 'ready', target: 'agent', name: 'chat', instanceId: 'live-test' });
	socket.send(JSON.stringify({ version: 1, type: 'ping', requestId: 'ping-live' }));
	const pong = await waitForMessage(messages, (message) => message.type === 'pong');
	assert.deepEqual(pong, { version: 1, type: 'pong', requestId: 'ping-live' });
	socket.close();
}

async function assertWorkflow(pathname) {
	const { socket, messages } = await connect(pathname, (message) => message.type === 'ready');
	assert.deepEqual(messages[0], { version: 1, type: 'ready', target: 'workflow', name: 'live-smoke' });
	const closed = waitForClose(socket);
	socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'workflow-live', payload: { marker: 'native-websocket' } }));
	const result = await waitForMessage(messages, (message) => message.type === 'result');
	assert.equal(result.requestId, 'workflow-live');
	assert.deepEqual(result.result, { echoed: 'native-websocket' });
	assert(messages.some((message) => message.type === 'started' && message.requestId === 'workflow-live'));
	assert(messages.some((message) => message.type === 'event' && message.requestId === 'workflow-live'));
	const close = await closed;
	assert.equal(close.code, 1000);
	assert.equal(close.reason, 'Workflow completed');
}

async function connect(pathname, ready) {
	const deadline = Date.now() + 10000;
	let lastError;
	while (Date.now() < deadline) {
		const socket = new WebSocket(new URL(pathname, baseUrl));
		const messages = [];
		socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
		try {
			await new Promise((resolve, reject) => {
				let interval;
				const finish = (callback) => {
					clearTimeout(timeout);
					clearInterval(interval);
					callback();
				};
				const timeout = setTimeout(() => finish(() => reject(new Error('Timed out waiting for WebSocket readiness.'))), 1000);
				socket.addEventListener('error', () => finish(() => reject(new Error('WebSocket connection failed before readiness.'))), { once: true });
				interval = setInterval(() => {
					if (messages.some(ready)) finish(resolve);
				}, 10);
			});
			return { socket, messages };
		} catch (error) {
			lastError = error;
			socket.close();
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError ?? new Error('Unable to connect to live WebSocket fixture.');
}

async function waitForMessage(messages, predicate) {
	for (let attempt = 0; attempt < 1000; attempt++) {
		const message = messages.find(predicate);
		if (message) return message;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}

function waitForClose(socket) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close.')), 10000);
		socket.addEventListener('close', (event) => {
			clearTimeout(timeout);
			resolve(event);
		}, { once: true });
	});
}
