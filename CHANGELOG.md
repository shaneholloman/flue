# Changelog

## 0.4.0

Big release! We are working hard to stabilize our APIs and add any missing and essential features to Flue that you need. There are some breaking changes to be aware of, when upgrading from `v0.3` to `v0.4`. Read through the list below to understand what's new and what's changed. Or, point your coding agent to this changelog URL for a more automated upgrade experience).

### Breaking Changes

- **New return type for `prompt()` / `skill()` / `task()` / `shell()`.** Two changes folded into one new shape:

  1. They now return a `CallHandle<T>` instead of a `Promise<T>`. `await` works exactly as before. The handle is a `PromiseLike` with `.signal: AbortSignal` and `.abort(reason?)` for synchronous cancellation, replacing the removed `PromptOptions.timeout` / `SkillOptions.timeout` / `ShellOptions.timeout` fields. Code that uses these as plain Promises without `await` (e.g. raw `.then()` / `.catch()` chains) may need adjustment.

  ```ts
  // Cancel via an AbortSignal on the options bag
  const result = await session.prompt("…", { signal: AbortSignal.timeout(5000) });

  // Or abort the handle directly
  const handle = session.prompt("…");
  setTimeout(() => handle.abort("user cancelled"), 5000);
  ```

  2. The awaited value is now `{ text | data, usage, model }` instead of a bare string or schema value. Schema-typed calls return `PromptResultResponse<T>`; non-schema calls return `PromptResponse` with the new `usage` and `model` fields. To migrate, read `response.text` or `response.data`:

  ```ts
  // Before
  const text = await session.prompt("…");
  const user = await session.prompt("…", { result: UserSchema });

  // After
  const { text } = await session.prompt("…");
  const { data: user } = await session.prompt("…", { schema: UserSchema });
  ```

  The schema option was renamed from `result` to `schema`, and the response field from `result` to `data`. The old `result` spellings (both the option and the response field) still work at runtime for backwards compatibility, but are typed as `never` so TypeScript flags new usage. Both names will be removed in a future release.

  Schema results are now extracted via injected `finish` / `give_up` model-facing tools instead of `---RESULT_START---` / `---RESULT_END---` text markers. The unused `ResultExtractionError` class is removed; a new `ResultUnavailableError` is thrown when the model invokes `give_up`.

- **`commands` and `defineCommand` are removed.** The original idea — register first-party CLI tools the agent could shell out to — only worked under just-bash and saw little real use. The same surface is better expressed today by passing `env` to scope what a connector sees, or by choosing a sandbox connector that gives you the isolation you want. just-bash itself still supports custom commands — you just register them on your bash instance directly instead of through Flue's helper. Removed: the `commands?:` option on `init()` / `prompt()` / `skill()` / `task()` / `shell()`; the `Command`, `CommandDef`, `CommandOptions`, `CommandExecutor`, `CommandExecutorResult` types; the `defineCommand` export from `@flue/sdk/node` and `@flue/sdk/cloudflare`; the `command_start` / `command_end` `FlueEvent` variants; and the `BashLike.registerCommand` / `SessionEnv.scope` connector hooks.

- **Default `thinkingLevel` changed from `'off'` to `'medium'`.** Reasoning-capable models (e.g. gpt-5, claude-opus-4-7) will now reason by default on every `prompt()` / `skill()` / `task()` call. Non-reasoning models are unaffected (clamped to `'off'` per the model's `thinkingLevelMap`). To restore the old behavior, set `thinkingLevel: 'off'` explicitly on `init()`, your role frontmatter, or the call options.

- **`sandbox: 'local'` now runs locally.** Originally, `'local'` was a half-isolated layer — a `just-bash` subprocess with a `ReadWriteFs` / `MountableFs` overlay mounting `process.cwd()` at `/workspace`. That made sense when every Flue agent ran on a developer laptop, but increasingly people are deploying the agent itself *inside* a real sandbox (a container, a microVM, a Cloudflare Sandbox), where wrapping the host in a second virtual filesystem is pure overhead — and actively confusing, because paths get remapped twice. `sandbox: 'local'` now binds directly to the host: `exec` runs through the user's shell with full `process.env`, file methods hit the real filesystem, default `cwd` is `process.cwd()`, and there are no path remappings or command restrictions. Agents that hard-coded `/workspace` paths must migrate to real host paths. If you want isolation on a developer laptop, reach for a real sandbox connector (Daytona, E2B, Mirage, smolvm, etc.).

- **`commands` / `defineCommand` removed.** The `commands` API let you register user CLIs (`gh`, `npm`, etc.) into a sandbox-scoped `$PATH`, isolating secrets from the model. In practice it only ever worked when the sandbox was a `BashFactory` (the default in-memory sandbox or `getVirtualSandbox` on Cloudflare), and threw a runtime error on `'local'`, every remote connector (Daytona, E2B, Mirage, etc.), and Cloudflare Containers — so the documented "CI agent with `defineCommand('gh', { env: { GH_TOKEN } })`" pattern has been broken for most users since `'local'` was rebuilt. We're collapsing the API:

  - With the new `'local'` sandbox, the host shell is exposed directly. The agent's `bash` tool can run `gh issue view`, `npm test`, etc. with whatever's on `$PATH` and whatever env you launched flue with. The runner / container / VM is the isolation boundary.
  - For non-`'local'` sandboxes, install the binaries inside the sandbox image, or wrap the operation as a custom tool with `init({ tools: [...] })`. Tools have a structured parameter schema, are visible to the model directly, and recover the "secrets stay on the host" property — the tool reads `process.env`, the agent only sees the tool's params and result.

  Removed: `Command`, `CommandDef`, `CommandOptions`, `CommandExecutor`, `CommandExecutorResult` types; `defineCommand` from `@flue/sdk/node` and `@flue/sdk/cloudflare`; `commands?:` field on `init()`, `prompt()`, `skill()`, `task()`, `shell()`; `BashLike.registerCommand?`, `SessionEnv.scope?`; the dead `command_start` / `command_end` `FlueEvent` variants.

- **`init({ providers: { … } })` has moved.** Provider configuration moved to the new `app.ts` runtime registration model (see below). Migrate by creating an `app.ts` at your project root and calling `configureProvider()` (to patch a built-in catalog provider's `baseUrl` / `apiKey` / `headers` / `storeResponses`) or `registerProvider()` (to register a brand-new URL-prefix provider). Both are exported from `@flue/sdk/app`. The `ProvidersConfig` type and `providers` field are removed from `AgentInit` and `AgentConfig`.

- **`FlueAgent.destroy()` and `SessionEnv.cleanup()` are removed.** Flue no longer manages sandbox lifetime — sandboxes are user-owned. Connectors that previously took a `cleanup` option (Boxd, Daytona, E2B, Exedev, islo, Modal, Vercel) no longer accept it; some lose their options argument entirely (e.g. `daytona(sandbox)` instead of `daytona(sandbox, { cleanup })`). If you were relying on automatic teardown, destroy your sandbox explicitly when your handler is done.

- **CLI `--workspace` flag renamed to `--root`** across `flue dev` / `flue run` / `flue build`. The corresponding programmatic options also moved: `BuildOptions.workspaceDir` → `BuildOptions.root`, `BuildContext.workspaceDir` → `BuildContext.root`. The `flue.config.ts` key is `root`, not `workspace`.

- **`outputDir` renamed to `output`** across `BuildOptions`, `BuildContext`, and `DevOptions`. Build plugin authors reading `ctx.outputDir` must update to `ctx.output`. The CLI flag remains `--output`. The default is `<root>/dist`, and `--output` is now the literal output directory (previously it was a parent directory into which `dist/` was written). `BuildOptions.output` is now optional.

- **Built-in `/health` and `/agents` HTTP endpoints removed.** Projects that need them must author the routes in `app.ts`. `flue dev` and `flue run` no longer probe `/health`; `flue run` retries SSE POST on `ECONNREFUSED` for ~5s instead.

- **`Skill.instructions` field removed from the public type.** Skill bodies are no longer cached in memory — at call time the model reads `SKILL.md` from disk via its filesystem tools. This means relative references inside a skill resolve correctly, and edits are picked up mid-session without re-init. If you were reading `skill.instructions` from the SDK types, read the file from disk yourself.

- **Sandbox connector contract: `SandboxApi.exec` is now timeout-primary, signal-optional.** Connectors are expected to forward `timeout` to their provider's native timeout option (E2B `timeoutMs`, Daytona `timeout`, etc.); signal-aware SDKs may additionally forward `signal` for true mid-flight cancellation. `BashLike.exec` options gained `signal?: AbortSignal`. If you maintain a sandbox connector, see `docs/sandbox-connector-spec.md` for the dual contract.

- **Long-running agents on Node no longer time out at ~300s.** The generated Node server now sets `requestTimeout: 0` on the underlying `http.Server` and emits a 25s SSE heartbeat, which keeps undici's `bodyTimeout` and reverse-proxy idle timers satisfied. Multi-minute `bash` calls and other long handlers that emit no Flue-level events for >300s no longer abort with `[flue] Agent error: terminated`.

### New Features

- **`flue.config.ts` project config.** A `flue.config.{ts,mts,mjs,js,cjs,cts}` file at the project root is auto-discovered and can set `target` (`'node' | 'cloudflare'`), `root`, and `output`. CLI flags still win per-field. Authored in TypeScript via Node's native type-stripping (no bundling). New `--config <path>` flag on `flue dev` / `flue run` / `flue build`. New `@flue/sdk/config` subpath export with `defineConfig`, `resolveConfig`, `resolveConfigPath`, `UserFlueConfig`, `FlueConfig`, `ResolveConfigOptions`, `ResolvedConfigResult`.

  ```ts
  // flue.config.ts
  import { defineConfig } from '@flue/sdk/config';

  export default defineConfig({
    target: 'cloudflare',
  });
  ```

- **`flue init` command** scaffolds a starter `flue.config.ts` in the target directory. Flags: `--target <node|cloudflare>` (required), `--root <path>`, `--force` (overwrite existing).

- **`app.ts` runtime entry point.** A new optional `app.ts` (also `.mts` / `.js` / `.mjs`) at the source root lets you take over the request pipeline with custom Hono middleware, routes, auth, etc. Mount Flue's agent handler via `app.route('/', flue())`. New `@flue/sdk/app` subpath export ships:

  - `flue()` — Hono sub-app exposing `/agents/:name/:id`.
  - `Fetchable` — type for the user app's default export.
  - `registerProvider(name, def)` — register a new URL-prefix model provider at runtime, with platform `env` in scope. Supports HTTP and Cloudflare AI binding registrations (`HttpProviderRegistration`, `CloudflareAIBindingRegistration`, `CloudflareAIBinding`).
  - `registerApiProvider` — re-exported from pi-ai for entirely new wire protocols.
  - `configureProvider(slug, settings)` — patch `baseUrl` / `apiKey` / `headers` / `storeResponses` on an existing pi-ai catalog provider or previously registered prefix.

- **`.flue/`-as-source layout.** When `<root>/.flue/` exists, source files (`agents/`, `roles/`, optional `app.ts`) are read from there; otherwise from `<root>/` directly. `.flue/` wins unconditionally if present.

- **AbortSignal cancellation across `prompt()` / `skill()` / `task()` / `shell()`.** Pass `signal: AbortSignal` (e.g. `AbortSignal.timeout(5000)`) on the options bag, or use the new `CallHandle.abort(reason?)` method on the returned handle. Aborts reject with a standard `DOMException` named `AbortError` whose `cause` is the signal's reason. Aborting a `prompt()` also tears down in-flight `bash` tool commands, not just the model loop. `SessionEnv.exec()` also accepts `signal?` alongside `timeout?`.

- **Per-call reasoning effort.** New `thinkingLevel?: ThinkingLevel` on `AgentInit`, `Role` (also via role frontmatter `thinkingLevel:`), `PromptOptions`, `SkillOptions`, `TaskOptions`, and `AgentConfig`. Precedence: per-call > role > agent. Tasks inherit the parent's resolved level. Per-call `'off'` is rejected (init/role/agent-level only). Unknown values in role frontmatter throw at build time. `ThinkingLevel` re-exported from `@flue/sdk` and `@flue/sdk/client`. A single deployment can now serve a cheap classifier at `'low'` and a careful auditor at `'high'` from the same model entry.

- **Images on `prompt()` / `skill()` / `task()`.** New `images?: PromptImage[]` option on all three (and the initial turn of `task()`). `PromptImage` is the shape `{ type: 'image', data: base64, mimeType }`, re-exported from pi-ai. Requires a vision-capable model. For schema-result calls, images are attached on the first attempt only; retries are text-only.

- **Token + cost usage on every response.** `PromptResponse` (and the new `PromptResultResponse<T>`) now include `usage: PromptUsage` and `model: PromptModel`. `PromptUsage` aggregates across every LLM call dispatched by a single invocation — assistant turns, schema-result retries, the 1–2 compaction summarization calls, and the post-compaction overflow retry. Fields: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, plus a `cost` breakdown (`input`, `output`, `cacheRead`, `cacheWrite`, `total`). `PromptModel.id` reflects the model Flue selected via call > role > agent precedence.

- **Thinking events on the SSE stream.** Three new `FlueEvent` variants: `thinking_start`, `thinking_delta` (with `delta: string`), and `thinking_end` (with `content: string`). `flue run` renders them as dimmed lines under a `thinking:start` marker.

- **`fs` surface on `FlueAgent` and `FlueSession`.** Out-of-band sandbox filesystem access that doesn't appear in the conversation transcript — useful for staging inputs and reading back outputs around a `prompt()` call. Methods: `readFile`, `readFileBuffer`, `writeFile` (string or `Uint8Array`), `stat`, `readdir`, `exists`, `mkdir({ recursive? })`, `rm({ recursive?, force? })`. Paths resolve relative to the agent's `cwd`.

- **`ctx.req: Request | undefined` on `FlueContext`.** Standard Fetch `Request` for the current invocation — read headers (`req.headers.get('authorization')`), method, URL, and the raw body via `req.text()` / `req.json()` / `req.arrayBuffer()` / `req.formData()`. Body is preserved for handlers (Flue's internal JSON parser consumes a clone), so HMAC signature verification over raw bytes works directly without `req.clone()`. Undefined when an agent is invoked outside an HTTP context.

- **Cloudflare Workers AI binding provider.** Models prefixed `cloudflare/<model-id>` route through `env.AI.run()` on the Cloudflare target with no API tokens — the only setup is `"ai": { "binding": "AI" }` in `wrangler.jsonc`. Works across role models, sub-tasks, and compaction. Hard error on `--target node` pointing users at pi-ai's URL-based providers.

- **`ProviderSettings.storeResponses?: boolean`** opt-in. When enabled, sets `store: true` on outgoing requests for `openai-responses` and `azure-openai-responses`, enabling multi-turn against reasoning models when `thinkingLevel: 'off'` is explicitly set. (Codex Responses intentionally excluded — it rejects `store: true`.)

- **`session.shell()` is now a first-class transcript citizen.** It emits the same `tool_start` / `tool_end` events as an LLM-issued `bash` call (shared `toolCallId`, `toolName: 'bash'`) and appends a user / assistant tool-use / toolResult triple to history. Per-call `cwd` and `env` overrides are preserved in the synthetic tool-call `arguments` so they remain visible to the model on subsequent turns. Aborted commands now produce a `toolResult` with `isError: true` and the error message as text (previously dropped silently).

- **Skills are now read from disk on demand.** `session.skill()` references the skill by name and the system prompt's "Available Skills" registry tells the model where to find it (`.agents/skills/<name>/SKILL.md`). Relative references inside a skill (sibling markdown files, scripts) now resolve from where they live, and edits to `SKILL.md` are picked up mid-session without re-init. Path-based references produce a distinct prompt naming the file path explicitly.

- **`createLocalSessionEnv()` helper** exported from `@flue/sdk/node`. A pure-Node `SessionEnv` backed directly by `node:fs/promises` and `node:child_process`. Configurable `cwd` via `LocalSessionEnvOptions`. `exec` honors `timeout` + `signal` and lifts the default output buffer cap to 64 MB. This is what powers the new `sandbox: 'local'` behavior.

