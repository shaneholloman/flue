---
title: Data Persistence API
description: Reference for Flue persistence adapters, stores, and session data.
---

Adapter authors implement these contracts to back a custom database. Import them from `@flue/runtime/adapter`:

```ts
import type {
  AgentExecutionStore,
  AgentSubmissionStore,
  EventStreamMeta,
  EventStreamReadResult,
  EventStreamStore,
  PersistenceAdapter,
  RunStore,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
import { formatOffset, parseOffset } from '@flue/runtime/adapter';
```

Application code usually configures an adapter through `db.ts` rather than implementing one; see [Database](/docs/guide/database/) for setup and target behavior. Most applications use the built-in `sqlite()` adapter or `@flue/postgres`.

Always typecheck a custom adapter against the real types from `@flue/runtime/adapter`. The signatures below reference vocabulary types — such as `AgentSubmission`, `AgentTurnJournal`, `RunRecord`, and `RunPointer` — exported from the same subpath. If this page drifts from the package, the package wins.

## `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  connect(): AgentExecutionStore;
  connectRunStore(): RunStore;
  connectEventStreamStore(): EventStreamStore;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

A persistence adapter provides the database-backed stores used by a generated Node server. Flue calls `migrate()` once at startup when present, then calls `connect()`, `connectRunStore()`, and `connectEventStreamStore()`. On shutdown, Flue calls `close()` when present. Adapters that create schema implicitly may omit `migrate()`, but must still uphold the schema-versioning obligation below in their store-creating paths.

| Method | Contract |
| --- | --- |
| `connect()` | Return agent session and submission storage. |
| `connectRunStore()` | Return workflow-run records, lookup, and listing storage. |
| `connectEventStreamStore()` | Return durable event-stream storage for agent and workflow events. |
| `migrate?()` | Bring the store to the current schema/format version before connecting. |
| `close?()` | Release connections, pools, or file handles during shutdown. |

### Schema versioning

Every adapter must durably record its schema/format version when it first creates the store, and fail loudly — before reading or writing any data — when opened against a store recorded with an unknown or newer version (for example, a database last touched by a newer Flue version after a rollback). The built-in SQL adapters record the version in a one-row `flue_meta` key/value table (key `'schema_version'`); non-SQL adapters implement the same obligation natively (a key, a meta document, etc.).

`@flue/runtime/adapter` exports the pieces an adapter needs:

- `FLUE_SCHEMA_VERSION` — the current schema/format version to record at store creation.
- `assertSupportedFlueSchemaVersion(storedVersion)` — throws unless the recorded version matches the current one.
- `PersistedSchemaVersionError` — the error thrown on a version mismatch.

## `AgentExecutionStore`

```ts
interface AgentExecutionStore {
  readonly sessions: SessionStore;
  readonly submissions: AgentSubmissionStore;
}
```

The execution store groups agent conversation storage and submission lifecycle storage.

## `SessionStore`

```ts
interface SessionStore {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
}
```

| Method | Contract |
| --- | --- |
| `save(id, data)` | Persist the complete current session record under the supplied Flue storage key. |
| `load(id)` | Return the saved session record, or `null` when none exists. |
| `delete(id)` | Delete the stored session record for that key. |

## `AgentSubmissionStore`

```ts
interface AgentSubmissionStore {
  getSubmission(submissionId: string): Promise<AgentSubmission | null>;
  getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null>;
  hasUnsettledSubmissions(): Promise<boolean>;
  listRunnableSubmissions(): Promise<AgentSubmission[]>;
  listRunningSubmissions(): Promise<AgentSubmission[]>;
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
  appendStreamChunkSegment(streamKey: string, segmentIndex: number, body: string): Promise<boolean>;
  getStreamChunkSegments(streamKey: string): Promise<Array<{ segmentIndex: number; body: string }>>;
  deleteStreamChunkSegments(streamKey: string): Promise<void>;
  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;
  claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
  markSubmissionInputApplied(attempt: SubmissionAttemptRef, durability?: SubmissionDurability): Promise<boolean>;
  requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
  requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
  completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;
  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
  deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
}
```

The submission store owns ordered admission, claim ownership, turn journals, stream chunks, recovery, lease renewal, and deletion coordination for direct prompts and `dispatch(...)` input.

## `RunStore`

```ts
interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  endRun(input: EndRunInput): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  lookupRun(runId: string): Promise<RunPointer | null>;
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}
```

The run store persists workflow-run records and serves run lookup and listing for `/runs`, `flue logs`, and the [inspection primitives](#inspection-primitives). Event payloads live in `EventStreamStore`. Agent prompts and dispatched agent input do not create workflow runs.

| Method | Contract |
| --- | --- |
| `createRun()` | Persist a new `active` run record. Idempotent, first-writer-wins: when a record with the same `runId` already exists, the call is a no-op and the existing record — including any terminal status, result, or error — is preserved (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`). |
| `endRun()` | Finalize a run record with its terminal status, result, or error. A no-op when no record exists for `runId`. |
| `getRun()` | Return the full run record, or `null` when unknown. |
| `lookupRun()` | Return the `RunPointer` projection of `getRun()` — every record field except `payload`, `result`, and `error` — or `null` when unknown. |
| `listRuns()` | List run pointers newest first (`startedAt` descending, then `runId` descending), filtered by `status`/`workflowName` and paginated via the opaque `nextCursor`. |

Single-database adapters back all five methods from one run-records table; pointers are a column-subset select. Verify a custom implementation with `defineRunStoreContractTests` from `@flue/runtime/test-utils`.

## Inspection primitives

```ts
import { getRun, listAgents, listRuns } from '@flue/runtime';

function listRuns(options?: ListRunsOpts): Promise<ListRunsResponse>;
function getRun(runId: string): Promise<RunRecord | null>;
function listAgents(): Promise<AgentManifestEntry[]>;
```

Server-side free functions for application code running inside a Flue-built server. Like `dispatch(...)`, they read the generated runtime: `listRuns()` and `getRun()` read the configured run store, and `listAgents()` returns the built agents (`{ name, transports, created }`) from the deployment manifest. Use them to [compose your own admin endpoints](/docs/api/routing-api/#compose-your-own-admin-endpoints) behind application-owned authorization — Flue ships no inspection HTTP surface of its own.

## `EventStreamStore`

```ts
interface EventStreamStore {
  createStream(path: string): Promise<void>;
  appendEvent(path: string, event: unknown): Promise<string>;
  readEvents(
    path: string,
    opts?: { offset?: string; limit?: number },
  ): Promise<EventStreamReadResult>;
  closeStream(path: string): Promise<void>;
  getStreamMeta(path: string): Promise<EventStreamMeta | null>;
  subscribe(path: string, listener: () => void): () => void;
  deleteStream(path: string): Promise<void>;
}
```

`EventStreamStore` owns append-only event streams for agent instances and workflow runs. A path is typically `agents/<name>/<id>` or `runs/<runId>`. `appendEvent()` returns the new Durable Streams offset. `readEvents()` reads events strictly after `offset`; `"-1"` starts at the beginning and `"now"` starts at the current tail. `subscribe()` registers an in-process listener for appends or closure on that store instance; it is not a cross-process notification contract.

## `SessionData`

```ts
interface SessionData {
  version: 5;
  affinityKey: string;
  entries: SessionEntry[];
  leafId: string | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
```

`SessionData` is the complete persisted conversation record for one session.

| Field | Contract |
| --- | --- |
| `version` | Storage format version. Flue rejects unsupported versions. |
| `affinityKey` | Opaque Flue-generated provider-affinity key. Persist it unchanged. |
| `entries` | Stored message and compaction history. |
| `leafId` | Current active leaf in the session history tree, or `null`. |
| `metadata` | Application-visible session metadata. |
| `createdAt` | ISO timestamp for session creation. |
| `updatedAt` | ISO timestamp for the last persisted update. |

`SessionData` may contain model-visible text, tool output, dispatch snapshots, and summaries derived from earlier content. Treat it as potentially sensitive.

## Adapter helpers

`@flue/runtime/adapter` also exports helper types and functions for custom backends, including:

- `createSessionStorageKey(...)`
- `parseAcceptedAt(...)`
- `FLUE_SCHEMA_VERSION`
- `assertSupportedFlueSchemaVersion(...)`
- `isSubmissionPayload(...)`
- `SUBMISSION_HARNESS_NAME`
- `DEFAULT_LIST_LIMIT`
- `MAX_LIST_LIMIT`
- `encodeRunCursor(...)`
- `decodeRunCursor(...)`
- `formatOffset(...)`
- `parseOffset(...)`

Use these helpers when implementing a backend that needs to preserve Flue's storage-key, timestamp, payload-validation, cursor, or event-stream offset semantics.
