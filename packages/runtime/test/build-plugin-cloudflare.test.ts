import { describe, expect, it } from 'vitest';
import { CloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('Cloudflare build plugin', () => {
	it('fails external-channel dispatch processing clearly instead of using memory fallback', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('Cloudflare external-channel dispatch processing is not supported yet');
		expect(entry).toContain('Dispatch must route to the target agent Durable Object');
		expect(entry).not.toContain('createAgentDispatchProcessor');
		expect(entry).not.toContain('createContextForRequest(id, runId, payload, undefined, req)');
	});

	it('threads generated Durable Object identity through Cloudflare context', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('const agentClassNames = {');
		expect(entry).toContain('"moderator": "Moderator"');
		expect(entry).toContain('const workflowClassNames = {');
		expect(entry).toContain('"daily-report": "DailyReportWorkflow"');
		expect(entry).toContain('durableObjectIdentity: createDurableObjectIdentity(doInstance, identity)');
		expect(entry).toContain('bindingName: workflowBindingNameFromWorkflowName(workflowName)');
		expect(entry).toContain('bindingName: agentBindingNameFromAgentName(agentName)');
		expect(entry).not.toContain('createRegistryIdentity');
	});

	it('generates exclusive hibernating WebSocket handling inside owning Durable Objects', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('const websocketAgentHandlers = {};');
		expect(entry).toContain('const websocketWorkflowHandlers = {};');
		expect(entry).toContain('connectCloudflareAgentWebSocket');
		expect(entry).toContain('messageCloudflareWorkflowWebSocket');
		expect(entry).toContain('if (isWebSocketUpgrade(request)) {');
		expect(entry).toContain('await this.__unsafe_ensureInitialized();');
		expect(entry).toContain("if (isFlueSocket(socket, 'agent', \"moderator\"))");
		expect(entry).toContain("if (isFlueSocket(socket, 'workflow', \"daily-report\"))");
		expect(entry).toContain('doInstance.ctx.acceptWebSocket(server);');
		expect(entry).toContain("if (code === 1005 || code === 1006 || code === 1015) return;");
		expect(entry).toContain("return closeFlueSocket(socket, code, reason);");
		expect(entry).toContain("return closeFlueSocket(socket, 1011, 'WebSocket error');");
		expect(entry).toContain('connectCloudflareAgentWebSocket(server, { name: agentName, id: doInstance.name, requestUrl: socketRequestUrl(request) });');
		expect(entry).toContain("url.search = '';");
		expect(entry).toContain('request: socketRequest(connection)');
		expect(entry).not.toContain('shouldSendProtocolMessages()');
	});

	it('rejects WebSocket modules when custom app routing owns Cloudflare requests', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint({ ...testBuildContext(), appEntry: '/tmp/app.ts' });

		expect(entry).toContain('websocket() on the Cloudflare target currently requires the generated default app.');
		expect(entry).toContain('Custom app.ts WebSocket mounting is not yet supported.');
	});

});

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'moderator', filePath: '/tmp/moderator.ts', hasChannels: true, hasReceive: true, hasDefaultAgent: true }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts', hasChannels: true }],
		manifest: {
			agents: [{ name: 'moderator', channels: {}, receive: true, created: true }],
			workflows: [{ name: 'daily-report', channels: {} }],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'cloudflare' },
	};
}
