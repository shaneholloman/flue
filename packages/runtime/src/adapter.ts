/**
 * Public adapter interface for persistence implementations.
 *
 * This subpath exports the types, interfaces, and helper functions needed
 * to implement a custom {@link PersistenceAdapter}. Use it when building
 * a persistence backend for a database not covered by the built-in adapters.
 *
 * ```ts
 * import type { AgentExecutionStore, PersistenceAdapter } from '@flue/runtime/adapter';
 * import { createSessionStorageKey, parseAcceptedAt } from '@flue/runtime/adapter';
 * ```
 *
 * This surface is intentionally narrow: store interfaces, vocabulary types,
 * and pure adapter helper functions. It does not expose runtime orchestration,
 * provider plumbing, or generated-entry internals.
 */

// ─── Store interfaces and vocabulary types ──────────────────────────────────

export type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionClaimRef,
	SubmissionDurability,
} from './agent-execution-store.ts';

export {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';

// ─── Submission input types ─────────────────────────────────────────────────

export type {
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';

export { createDispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';

export type { DispatchInput } from './runtime/dispatch-queue.ts';

// ─── Adapter helper functions ───────────────────────────────────────────────

export {
	deduplicateSessionDeletion,
	isSubmissionPayload,
	parseAcceptedAt,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from './adapter-helpers.ts';

export type { SubmissionPayloadContext } from './adapter-helpers.ts';

export { createSessionStorageKey } from './session-identity.ts';

// ─── Schema versioning ──────────────────────────────────────────────────────

export { assertSupportedFlueSchemaVersion, FLUE_SCHEMA_VERSION } from './schema-version.ts';
export { PersistedSchemaVersionError } from './errors.ts';

// ─── Run store types ─────────────────────────────────────────────────────────

export type {
	CreateRunInput,
	EndRunInput,
	ListRunsOpts,
	ListRunsResponse,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
} from './runtime/run-store.ts';
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, encodeRunCursor, decodeRunCursor } from './runtime/run-store.ts';

// ─── Event stream store ─────────────────────────────────────────────────────

export type { EventStreamStore, EventStreamMeta, EventStreamReadResult } from './runtime/event-stream-store.ts';
export { formatOffset, parseOffset } from './runtime/event-stream-store.ts';

// ─── Re-export session types needed for SessionStore implementations ────────

export type { SessionData, SessionStore, TaskSessionRef } from './types.ts';
