---
title: MySQL
description: Give Flue agents and workflow runs durable, shared state with MySQL 8 and InnoDB.
subtitle: Persist agent sessions, accepted submissions, and workflow-run history in MySQL so state survives restarts and is shared across replicas.
package:
  name: '@flue/mysql'
  href: https://www.npmjs.com/package/@flue/mysql
---

## Add MySQL

Add MySQL-backed persistence to an existing Flue project with:

```sh
flue add database mysql
```

The blueprint installs `@flue/mysql` and `mysql2`, then writes a source-root
`db.ts`. Flue discovers that file at build time and wires it into the generated
Node server.

`@flue/mysql` supports **MySQL 8 with InnoDB** on the **Node.js target**. The
Cloudflare target uses Durable Object SQLite automatically and rejects `db.ts`
at build time. See [Database](/docs/guide/database/) for persistence by target.

## Configure

Set one application secret:

| Variable | Purpose |
| --- | --- |
| `MYSQL_URL` | MySQL connection string, supplied by your database provider. |

The driver reads this value at runtime. Supply it through your platform's
secret store, never commit it, and configure `mysql2` TLS options when your
provider requires them. For local development, `flue dev --env <file>` and
`flue run --env <file>` load any `.env`-format file.

## Bring your own driver

`@flue/mysql` does not bundle a production driver. It accepts a runner so your
application owns pooling, TLS, credentials, and connection lifecycle. The
canonical `mysql2` runner uses `pool.execute()` for normal queries and one
checked-out connection for each callback transaction:

```ts title="src/db.ts"
import { mysql, type MysqlQuery } from '@flue/mysql';
import mysql2 from 'mysql2/promise';

const pool = mysql2.createPool(process.env.MYSQL_URL!);

const toRows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result.map((row) => ({ ...row })) : [];

export default mysql({
  query: async (text, params = []) => {
    const [result] = await pool.execute(text, params);
    return toRows(result);
  },
  transaction: async <T>(fn: (tx: { query: MysqlQuery }) => Promise<T>) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn({
        query: async (text, params = []) => {
          const [rows] = await connection.execute(text, params);
          return toRows(rows);
        },
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
  close: () => pool.end(),
});
```

The runner uses `?` placeholders and returns plain row objects. Every query in a
transaction callback must use the checked-out connection; issuing those calls
through the pool could move work onto another connection and outside the
transaction.

## Migrations

The adapter's `migrate()` hook runs automatically when the generated Node
server starts. It creates Flue's `flue_*` tables idempotently, verifies the
complete schema, and then stamps its version. All transactional tables use
InnoDB. There is no separate migration command, and a database written by a
newer Flue version refuses to start rather than risking incompatible writes.

## What gets stored

A Flue database stores runtime state, not your whole application.

| Stored by Flue | Not stored by Flue |
| --- | --- |
| Agent session messages, compaction state, and persisted image chunks | Sandbox files and installed dependencies |
| Accepted direct prompts and `dispatch(...)` submissions | External API side effects |
| Durable turn journals, claims, and leases | Application-owned business data |
| Workflow-run records, persisted events, and run indexes | Provider credentials or secrets |

See [Durable Agents](/docs/concepts/durable-execution/) for recovery behavior
and the [Data Persistence API](/docs/api/data-persistence-api/) for the adapter
contract.

## When to choose MySQL

Choose MySQL when your Node deployment already operates MySQL 8, or when
multiple replicas need durable shared agent and workflow state in an
InnoDB-backed database. For single-host persistence, file-backed `sqlite()` may
be simpler. Choose [`@flue/postgres`](/docs/ecosystem/databases/postgres/) when
Postgres is your existing operational standard, or
[`@flue/libsql`](/docs/ecosystem/databases/libsql/) for SQLite and libSQL
workloads.
