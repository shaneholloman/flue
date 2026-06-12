/**
 * Shared agent execution store interface.
 *
 * Both Cloudflare (DO SQLite) and Node (node:sqlite :memory:) implement this
 * contract using the same underlying SQL store. The interface is target-neutral
 * so that future persistent backends (Postgres, MySQL, Turso, etc.) can
 * implement it directly.
 */

import type { AgentSubmissionInput, DirectAgentSubmissionInput } from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import type { RunStore } from './runtime/run-store.ts';
import type { SessionStore } from './types.ts';

// ─── Durability defaults ────────────────────────────────────────────────────

/** Default maximum total attempts before terminalization. */
export const DURABILITY_DEFAULT_MAX_ATTEMPTS = 10;
/** Default submission timeout in milliseconds (one hour). */
export const DURABILITY_DEFAULT_TIMEOUT_MS = 3_600_000;
/** Default lease duration for submission ownership in milliseconds (30 seconds). */
export const LEASE_DURATION_MS = 30_000;

// ─── Submission ─────────────────────────────────────────────────────────────

type AgentSubmissionStatus = 'queued' | 'running' | 'settled';

export interface AgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: AgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	readonly recoveryRequestedAt?: number;
	readonly startedAt?: number;
	readonly error?: string;
	readonly attemptCount: number;
	readonly maxRetry: number;
	readonly timeoutAt: number;
	readonly ownerId?: string;
	readonly leaseExpiresAt: number;
}

export interface SubmissionAttemptRef {
	readonly submissionId: string;
	readonly attemptId: string;
}

export interface SubmissionClaimRef extends SubmissionAttemptRef {
	readonly ownerId: string;
	readonly leaseExpiresAt: number;
}

export interface SubmissionDurability {
	readonly maxRetry: number;
	readonly timeoutAt: number;
}

/**
 * Flue-owned durable evidence that a submission attempt was started and has
 * not yet settled. The Cloudflare coordinator inserts a marker immediately
 * before starting an attempt fiber and deletes it when the attempt settles;
 * reconciliation treats a fresh marker as proof that the attempt may still
 * be running and must not be reconciled as interrupted.
 */
export interface AgentAttemptMarker {
	readonly submissionId: string;
	readonly attemptId: string;
	readonly createdAt: number;
}

// ─── Dispatch admission ─────────────────────────────────────────────────────

export interface AgentDispatchReceipt {
	readonly submissionId: string;
	readonly acceptedAt: number;
}

export type AgentDispatchAdmission =
	| { readonly kind: 'submission'; readonly submission: AgentSubmission }
	| { readonly kind: 'retained_receipt'; readonly receipt: AgentDispatchReceipt }
	| { readonly kind: 'conflict' };

// ─── Turn journal ───────────────────────────────────────────────────────────

export type AgentTurnJournalPhase =
	| 'before_provider'
	| 'provider_started'
	| 'tool_request_recorded'
	| 'committed';

export interface AgentTurnJournal {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
	readonly streamKey?: string;
	readonly streamConsumedAt?: number;
	readonly committed: boolean;
	readonly committedLeafId?: string;
}

export interface CreateTurnJournalInput {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
}

// ─── Submission store ───────────────────────────────────────────────────────

export interface AgentSubmissionStore {
	// Query
	getSubmission(submissionId: string): Promise<AgentSubmission | null>;
	getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null>;
	hasUnsettledSubmissions(): Promise<boolean>;
	listRunnableSubmissions(): Promise<AgentSubmission[]>;
	listRunningSubmissions(): Promise<AgentSubmission[]>;

	// Turn journal lifecycle
	beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean>;
	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options?: {
			checkpointLeafId?: string;
			toolRequest?: unknown;
			streamKey?: string;
		},
	): Promise<boolean>;
	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean>;
	markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean>;
	replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null>;

	// Stream chunks
	appendStreamChunkSegment(streamKey: string, segmentIndex: number, body: string): Promise<boolean>;
	getStreamChunkSegments(streamKey: string): Promise<Array<{ segmentIndex: number; body: string }>>;
	deleteStreamChunkSegments(streamKey: string): Promise<void>;

	// Admission
	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
	admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;

	// Submission lifecycle
	claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
	markSubmissionInputApplied(attempt: SubmissionAttemptRef, durability?: SubmissionDurability): Promise<boolean>;
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;

	// Attempt markers
	insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
	deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
	listAttemptMarkers(): Promise<AgentAttemptMarker[]>;

	// Lease management
	renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
	listExpiredSubmissions(): Promise<AgentSubmission[]>;

	// Deletion
	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
	/**
	 * List session keys with a durable deletion marker (deletion started but
	 * never completed, e.g. the process crashed mid-deletion). Coordinators
	 * resume these at startup by calling {@link deleteSession} again —
	 * otherwise the marker blocks all admissions for the session forever.
	 */
	listPendingSessionDeletions(): Promise<string[]>;
}

// ─── Execution store ────────────────────────────────────────────────────────

export interface AgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: AgentSubmissionStore;
}

// ─── Persistence adapter ────────────────────────────────────────────────────

/**
 * A persistence adapter provides an {@link AgentExecutionStore} backed by a
 * specific database. Users configure persistence by creating a `db.ts` file
 * in their source root and default-exporting an adapter.
 *
 * Adapter packages export a factory function that returns this interface.
 * The built-in `sqlite()` adapter is available from `@flue/runtime/node`.
 *
 * Lifecycle: the framework calls `migrate()` (if present) once at startup
 * to bring the store to the current schema/format version, then calls
 * `connect()` to obtain the store. On shutdown, `close()` is called to
 * release resources.
 *
 * Versioning obligation (storage-agnostic): an adapter durably records its
 * schema/format version when it first creates the store, and fails loudly —
 * before reading or writing any data — when opened against a store recorded
 * with an unknown or newer version (e.g. throw
 * `PersistedSchemaVersionError`, exported from `@flue/runtime/adapter`).
 * The built-in SQL adapters implement this with a one-row `flue_meta`
 * key/value table (key `'schema_version'`); non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */
export interface PersistenceAdapter {
	/** Open the database connection and return the execution store. */
	connect(): AgentExecutionStore;
	/** Return a {@link RunStore} for workflow run records, lookup, and listing. */
	connectRunStore(): RunStore;
	/** Return an {@link EventStreamStore} for durable event stream persistence. */
	connectEventStreamStore(): import('./runtime/event-stream-store.ts').EventStreamStore;
	/**
	 * Bring the store to the current schema/format version.
	 * Called once at startup before {@link connect}. Creates any missing
	 * schema, durably records the schema/format version when the store is
	 * first created, and fails loudly when the store records an unknown or
	 * newer version. Adapters that create schema implicitly (e.g. LMDB) may
	 * omit this method, but must still uphold the versioning obligation in
	 * their store-creating paths.
	 */
	migrate?(): void | Promise<void>;
	/** Gracefully release resources (connection pools, file handles). */
	close?(): void | Promise<void>;
}
