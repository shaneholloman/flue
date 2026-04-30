# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Project Structure

- `packages/sdk/` — Core SDK (`@flue/sdk`). Build system, session management, agent harness, tools.
- `packages/cli/` — CLI (`@flue/cli`). `flue run` command.
- `examples/hello-world/` — Test workspace with 7 example agents.

## Building

SDK must be built before CLI or example agents:

```
pnpm run build          # in packages/sdk/
pnpm run build          # in packages/cli/
```

## Running Agents

Three commands:

- `flue dev` — long-running watch-mode dev server. Edits trigger rebuilds + reloads.
- `flue run` — one-shot, production-style: build, invoke an agent once, exit. Used in CI / scripted invocations.
- `flue build` — produce a `dist/` deployable artifact (no run).

`--workspace` points at the directory containing `agents/` and `roles/`. If omitted, the CLI looks for `./.flue/` first, else falls back to `./`. `--output` controls where `dist/` is written; defaults to the current directory.

### `flue dev`

Default port: `3583` ("FLUE" on a phone keypad). Override with `--port`.

```
cd examples/hello-world
node ../../packages/cli/dist/flue.js dev --target node
# or:
node ../../packages/cli/dist/flue.js dev --target cloudflare
```

For `--target cloudflare`, the project must have `wrangler` available (it's a peer dependency of `@flue/sdk`).

### `flue run`

```
node packages/cli/dist/flue.js run <agent-name> --target node --id <id> [--payload '<json>'] [--workspace <path>] [--output <path>]
```

Examples (run from the `examples/hello-world/` directory so the `./.flue/` waterfall picks it up):

```
cd examples/hello-world
node ../../packages/cli/dist/flue.js run hello --target node --id test-1
node ../../packages/cli/dist/flue.js run with-role --target node --id test-2 --payload '{"name": "Fred"}'
```

This builds the workspace, starts a temporary server, invokes the agent via SSE, streams output to stderr, prints the final result to stdout, and shuts down.

**Requires `ANTHROPIC_API_KEY` in the environment.** For testing, use `claude-haiku-4-5` (cheapest model).

## Type Checking

```
pnpm run check:types    # in packages/sdk/
```

## Architecture

### Agent = Deployed Workspace

A repo is built and deployed as an agent. `flue build` compiles the workspace (skills, roles, agents, context) into a self-contained server artifact. On every push to main, the agent is rebuilt and redeployed.
