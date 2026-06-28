import { sqlite } from '../../dist/node/index.mjs';

const [mode, dbPath] = process.argv.slice(2);
const adapter = sqlite(dbPath);
await adapter.migrate?.();
const stores = await adapter.connect();
const submissions = stores.executionStore.submissions;
const path = 'agents/assistant/instance-1';
const timestamp = new Date().toISOString();
const conversationId = `conversation-${mode}`;
const attemptId = `attempt-${mode}`;
const submissionId = `dispatch-${mode}`;
const input = mode === 'settlement'
	? {
			kind: 'direct',
			submissionId,
			agent: 'assistant',
			id: 'instance-1',
			payload: { message: mode },
			acceptedAt: timestamp,
		}
	: {
			kind: 'dispatch',
			submissionId,
			dispatchId: submissionId,
			agent: 'assistant',
			id: 'instance-1',
			input: { message: mode },
			acceptedAt: timestamp,
		};

if (input.kind === 'direct') await submissions.admitDirect(input);
else await submissions.admitDispatch(input);
await submissions.markSubmissionCanonicalReady(submissionId);
await submissions.claimSubmission({
	submissionId,
	attemptId,
	ownerId: 'killed-process',
	leaseExpiresAt: 1,
});
await stores.conversationStreamStore.createStream(path, {
	agentName: 'assistant',
	instanceId: 'instance-1',
});
const claim = await stores.conversationStreamStore.acquireProducer(path, 'killed-process');
let producerSequence = claim.nextProducerSequence;
const append = async (records) =>
	stores.conversationStreamStore.append({
		path,
		producerId: claim.producerId,
		producerEpoch: claim.producerEpoch,
		incarnation: claim.incarnation,
		producerSequence: producerSequence++,
		submission: { submissionId, attemptId },
		records,
	});
const scope = {
	v: 1,
	conversationId,
	harness: 'default',
	session: 'default',
	timestamp,
	submissionId,
	attemptId,
};
const inputEntryId = `entry_dispatch_${Buffer.from(submissionId).toString('base64url')}`;
await append([
	{
		v: 1,
		id: `record-created-${mode}`,
		type: 'conversation_created',
		kind: 'root',
		conversationId,
		harness: 'default',
		session: 'default',
		timestamp,
		affinityKey: `affinity-${mode}`,
		createdAt: timestamp,
	},
	{
		...scope,
		id: `record_dispatch_input_${submissionId}`,
		type: 'signal',
		dispatchId: submissionId,
		messageId: inputEntryId,
		parentId: null,
		signalType: 'dispatch_input',
		tagName: 'dispatch',
		content: JSON.stringify({ message: mode }, null, 2),
		attributes: {
			agent: input.agent,
			id: input.id,
			session: 'default',
			dispatchId: input.dispatchId,
			acceptedAt: input.acceptedAt,
		},
	},
]);

if (mode === 'input-marker') {
	process.send?.('ready');
	await new Promise(() => {});
}

await submissions.markSubmissionInputApplied({ submissionId, attemptId });

if (mode === 'stream-recovery') {
	// Genuine crash mid-stream: an assistant message is started with one
	// durable text delta acknowledged, but never completed and never recovered.
	// Recovery must materialize this partial exactly once and resume.
	await append([
		{
			...scope,
			id: 'record-stream-started',
			type: 'assistant_message_started',
			turnId: 'turn-stream',
			messageId: 'entry_stream_partial',
			parentId: inputEntryId,
			modelInfo: { api: 'faux', provider: 'faux', model: 'reviewer' },
		},
		{
			...scope,
			id: 'record-stream-text-started',
			type: 'assistant_text_started',
			messageId: 'entry_stream_partial',
			blockId: 'block-stream',
			blockIndex: 0,
		},
		{
			...scope,
			id: 'record-stream-delta',
			type: 'assistant_text_delta',
			messageId: 'entry_stream_partial',
			blockId: 'block-stream',
			sequence: 0,
			delta: 'Durable partial',
		},
	]);
}

if (mode === 'tool-repair' || mode === 'tool-outcome') {
	const toolCalls = mode === 'tool-outcome'
		? [
				{ type: 'toolCall', id: 'tool-call-1', name: 'lookup' },
				{ type: 'toolCall', id: 'tool-call-2', name: 'lookup' },
			]
		: [{ type: 'toolCall', id: 'tool-call-1', name: 'lookup' }];
	await append([
		{
			...scope,
			id: 'record-tool-started',
			type: 'assistant_message_started',
			messageId: 'entry_tool_assistant',
			parentId: inputEntryId,
			modelInfo: { api: 'faux', provider: 'faux', model: 'reviewer' },
		},
		...toolCalls.map((toolCall, index) => ({
			...scope,
			id: `record-tool-call-${index}`,
			type: 'assistant_tool_call',
			messageId: 'entry_tool_assistant',
			blockId: `block-tool-${index}`,
			blockIndex: index,
			toolCallId: toolCall.id,
			name: toolCall.name,
			arguments: {},
		})),
		{
			...scope,
			id: 'record-tool-completed',
			type: 'assistant_message_completed',
			messageId: 'entry_tool_assistant',
			stopReason: 'toolUse',
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	]);
	// tool-outcome: one of the two tool calls completed durably before the
	// crash; recovery must preserve it and error only the unresolved call.
	// tool-repair: the single tool call was interrupted before ANY outcome was
	// appended; recovery must write one unknown-outcome error and never re-run
	// the tool.
	if (mode === 'tool-outcome') {
		await append([{
			...scope,
			id: 'record-tool-outcome-1',
			type: 'tool_outcome',
			assistantMessageId: 'entry_tool_assistant',
			toolCallId: 'tool-call-1',
			toolName: 'lookup',
			isError: false,
			content: [{ type: 'text', text: 'Known completed result' }],
		}]);
	}
}

if (mode === 'settlement') {
	const settlement = {
		...scope,
		id: `record-settlement-${submissionId}`,
		type: 'submission_settled',
		outcome: 'failed',
		error: { message: 'Interrupted' },
	};
	await submissions.reserveSubmissionSettlement(
		{ submissionId, attemptId },
		{ recordId: settlement.id, record: settlement },
	);
	await append([settlement]);
}

process.send?.('ready');
await new Promise(() => {});
