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

	it('recovers agent turns and restarts interrupted Flue workflows as new runs', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('recoverAgentRun');
		expect(entry).toContain('reserveRecoveredAgentSession');
		expect(entry).toContain('failRecoveredRun');
		expect(entry).toContain("ctx.name.startsWith('flue:webhook:')");
		expect(entry).toContain('const run = await runStore.getRun(runId);');
		expect(entry).toContain("const startEvent = events.find((event) => event.type === 'run_start');");
		expect(entry).toContain('const payload = run?.payload !== undefined ? run.payload : startEvent?.payload;');
		expect(entry).toContain("ctx.name !== 'flue:workflow:' + doInstance.name");
		expect(entry).toContain('const restartRunId = generateWorkflowRunId(workflowName);');
		expect(entry).toContain("'x-flue-restarted-from-run-id': interruptedRunId");
		expect(entry).toContain('restartedAsRunId: restartRunId');
		expect(entry).toContain('Flue workflow execution was interrupted and restarted as run');
		expect(entry).toContain("return doInstance.runFiber('flue:workflow:' + runId");
		expect(entry).toContain("return doInstance.runFiber('flue:webhook:' + runId");
		expect(entry).not.toContain('flue_fiber_recovery');
		expect(entry).not.toContain('fiber?.stash?.');
		expect(entry).not.toContain('recoverWebhookRun');
		expect(entry).toContain("runId = decodeURIComponent(segments[1] || '');");
		expect(entry).toContain('createContext: (id_, runId, payload, req, initialEventIndex)');
		expect(entry).not.toContain("assertAgentsDurabilityApi(doInstance, 'startFiber');");
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

	it('allows custom app routing to own Cloudflare WebSocket middleware and mounts', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint({ ...testBuildContext(), appEntry: '/tmp/app.ts' });

		expect(entry).toContain("import userApp from '/tmp/app.ts';");
		expect(entry).toContain('return app.fetch(request, env, ctx);');
		expect(entry).not.toContain('Custom app.ts WebSocket mounting is not yet supported.');
	});

});

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'moderator', filePath: '/tmp/moderator.ts', hasChannels: true, attachedChannels: {}, hasReceive: true, hasDefaultAgent: true }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts', hasChannels: true, attachedChannels: {} }],
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
