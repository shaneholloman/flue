# Wrangler config merge — bug fix and dependency cleanup

**Status:** Ready to implement
**Scope:** `packages/sdk` only
**Estimated effort:** ~30–60 minutes including smoke tests

## Why we're doing this

There is a real, observable bug today: `flue build --target cloudflare && wrangler deploy --dry-run` fails for `examples/assistant` with:

```
The image "./Dockerfile" does not appear to be a valid path to a Dockerfile, or a valid image registry path
```

The user's `wrangler.jsonc` has `containers[].image: "./Dockerfile"`, which correctly resolves to `examples/assistant/Dockerfile` from the user's source location. But Flue's build merges the user config into `dist/wrangler.jsonc`, and wrangler resolves `image` paths **relative to the config file's own directory** (see `wrangler/wrangler-dist/cli.js`'s `isDockerfile`, currently around line 6027). So from `dist/wrangler.jsonc`, the value resolves to `dist/Dockerfile` — which doesn't exist.

This is the same class of problem that affects any wrangler config field whose value is a filesystem path resolved relative to the config file. Other examples:

- `assets.directory`
- `tsconfig`
- `build.command` / `build.cwd` / `build.watch_dir`
- `rules` (glob patterns)
- `site.bucket` (deprecated)

`containers[].image` is the only one we currently have evidence of users hitting in the Flue context. The others may or may not become problems; we'll handle them if/when they do.

While we're touching this code, we have an opportunity to clean up some adjacent things that fall out naturally:

1. We currently use `jsonc-parser` directly to parse the user's wrangler config. Wrangler exports `experimental_readRawConfig` (and `unstable_readConfig`) that does this for us. Switching gets us TOML support for free — currently we throw with a "convert to jsonc" message if a user has `wrangler.toml`.
2. We can type our config handling against wrangler's own `Unstable_RawConfig` / `Unstable_Config` rather than `Record<string, unknown>`.

## What we already considered and rejected

For context — these aren't options, just notes on why they're not in scope:

- **Use `@cloudflare/vite-plugin` for its helpers.** The plugin only exports `cloudflare()`, `getLocalWorkerdCompatibilityDate()`, `PluginConfig`, and `WorkerConfig`. None of the actually-useful internals (`outputConfigPlugin`, `readWorkerConfigFromFile`, path rewriters) are exported. Adopting it would also force a transitive Vite peer dependency on every Flue user, which is unacceptable since we don't use Vite.
- **Use `experimental_patchConfig` to replace our merge logic entirely.** Considered, rejected after looking at how Cloudflare's own Vite plugin handles this — they hand-roll output config construction the same way we do. There's no obvious win, and the merge semantics we want (de-dupe DO bindings by `name`, append migrations only if tag isn't already present) don't map cleanly to a JSON-merge-patch operation.
- **Copy referenced files into `dist/` instead of rewriting paths.** Works for a Dockerfile (small), scales poorly to `assets.directory` (could be hundreds of MB). Adds side effects to the build with paths derived from arbitrary user input. Not worth it.
- **Write the merged config in the user's source directory (e.g. `wrangler.flue.jsonc`).** Avoids path rewriting, but pollutes the user's source tree, requires `.gitignore` updates, and breaks our "everything generated lives in `dist/`" convention.

## What we did look at — closely

The Cloudflare Vite plugin's `outputConfigPlugin` (in `packages/vite-plugin-cloudflare/src/plugins/output-config.ts` in the `cloudflare/workers-sdk` repo). It does the same thing we do: build a wrangler config object in memory, stringify, write to disk. For path rewriting, it handles `assets.directory` via a one-off `path.relative(workerOutputDir, clientOutputDir)` call — exactly the pattern we'd use for `containers[].image`.

It does **not** handle `containers[].image`. Either Vite plugin users don't typically use containers (likely; containers are a recent Workers feature), or they hit the same bug and haven't fixed it yet. Either way, "do field-specific path rewriting where the bug actually shows up" is the established pattern, not a hack.

The Astro Cloudflare integration delegates entirely to `@cloudflare/vite-plugin` and never writes its own wrangler config — so it sidesteps the problem rather than solving it.

## Implementation plan

### 1. Replace our jsonc reader with wrangler's

Currently in `packages/sdk/src/cloudflare-wrangler-merge.ts`, `readUserWranglerConfig` does:

```ts
const source = fs.readFileSync(foundPath, 'utf-8');
const parsed = parseJsonc(source, errors, { allowTrailingComma: true });
```

Replace with a call to `experimental_readRawConfig` (or `unstable_readConfig`) from wrangler. Notes:

- These are exported as `experimental_readRawConfig` and `unstable_readConfig` from the top-level `wrangler` module. Either should work for our use case; `experimental_readRawConfig` is the closer 1:1 replacement (raw, unresolved). If `unstable_readConfig` proves more stable or has better behavior with `preserveOriginalMain: true` (the option Cloudflare's Vite plugin uses), prefer that. The implementer should pick whichever produces the cleaner output for us — both are listed as `unstable_`/`experimental_` so neither is fully stable.
- Wrangler is already a peer dependency. The wrangler import in `dev.ts` is lazy (dynamic `await import('wrangler')`). The merge code runs at build time, where we don't have the same Node-only-users concern — but for consistency and to avoid making wrangler a hard dependency for Node-target users, the implementer should consider whether to keep it lazy here too. (My suspicion: lazy is the right call. Node-only users still go through this build path, but only if they target Cloudflare. We could gate the import on the Cloudflare plugin being active — easy.)
- Keep the same return shape (`{ config, path }`) so callsites don't need to change.
- Drop the manual TOML rejection path. Wrangler handles TOML transparently.
- Drop the trailing-comma + parse-error handling that mirrors what wrangler already does internally.

If `experimental_readRawConfig` throws on invalid input, surface its error message with our `[flue]` prefix — the goal is friendly errors, not opaque ones.

### 2. Add `rewriteRelativePaths` helper

New function in `packages/sdk/src/cloudflare-wrangler-merge.ts`:

```ts
export function rewriteRelativePaths(
	merged: Record<string, unknown>,
	fromDir: string, // dirname(userConfigPath)
	toDir: string,   // dirname(outputConfigPath) — i.e. the dist dir
): Record<string, unknown>;
```

It walks the merged config and rewrites known relative-path fields so they still resolve to the same absolute file after the config moves to `dist/`.

Initial scope:

- `containers[].image` — the field with the demonstrated bug.

Heuristic for "is this a relative filesystem path":

- Starts with `./` or `../` → yes, rewrite.
- `path.isAbsolute(value)` → already absolute, leave alone (wrangler accepts absolute paths fine).
- Otherwise → assume it's a registry reference (`docker.io/foo:tag`, `myregistry.com/img:1.0`) and leave alone.

This matches user intent: `./Dockerfile` is unambiguously a path; `docker.io/foo:tag` is unambiguously a registry. The wrangler logic itself uses `fs.existsSync` to disambiguate — we can be simpler since we control the input shape.

Rewrite mechanics:

```ts
const abs = path.resolve(fromDir, image);
const rel = path.relative(toDir, abs);
// Ensure forward slashes (cross-platform) and a `./` or `../` prefix
const out = (rel.startsWith('.') ? rel : './' + rel).split(path.sep).join('/');
```

The Cloudflare Vite plugin uses `vite.normalizePath` for the same purpose; we don't have Vite, but the equivalent is `.split(path.sep).join('/')` — or `path.posix.relative` after normalizing inputs. Either works.

Add comments listing the other potentially-affected fields (`assets.directory`, `tsconfig`, `build.cwd`, etc.) with a note that the pattern is the same — extend when needed.

Pure function: doesn't mutate the input, returns a new object. Doesn't throw — if a user's `containers[].image` is malformed (not a string, etc.), pass through and let wrangler produce its own error downstream.

Edge case to be aware of: if a user has no `wrangler.jsonc` at all (e.g. our `examples/hello-world` before we added one), `fromDir` should fall back to a sensible value — probably the same as `toDir`, in which case rewriting is a no-op. The implementer should verify this works correctly when there's no user config.

### 3. Wire it in

In `packages/sdk/src/build-plugin-cloudflare.ts`'s `additionalOutputs`:

```ts
const merged = mergeFlueAdditions(userConfig, additions);
const userConfigDir = userConfigPath ? path.dirname(userConfigPath) : ctx.outputDir;
const distDir = path.join(ctx.outputDir, 'dist');
const finalMerged = rewriteRelativePaths(merged, userConfigDir, distDir);
// ... stringify and emit as `wrangler.jsonc`
```

`userConfigPath` is already returned by `readUserWranglerConfig` — it's available at the merge call site.

### 4. Migrate `dev.ts` off jsonc-parser too

In `packages/sdk/src/dev.ts`, `readConfigCompatFields` currently uses `parseJsonc` to extract `compatibility_date` and `compatibility_flags` from the generated `dist/wrangler.jsonc`. Migrate this to `experimental_readRawConfig` as well.

This is what unlocks dropping `jsonc-parser` from `packages/sdk/package.json` entirely.

The wrangler import in `dev.ts` is already lazy. Keep it that way; just add `experimental_readRawConfig` (or `unstable_readConfig`) alongside the existing `unstable_startWorker` import.

### 5. Drop `jsonc-parser` dependency

Once both call sites (cloudflare-wrangler-merge.ts and dev.ts) are migrated, remove `jsonc-parser` from `packages/sdk/package.json`'s `dependencies`. Verify with a fresh `pnpm install` and full SDK build that nothing else still references it.

If anything else does still use it, leave the dep and document why in a code comment.

### 6. Verify

These four scenarios cover the meaningful surface area. All should work after the change.

1. **`flue build --target cloudflare` for `examples/assistant`** (which has containers).
   - Confirm `dist/wrangler.jsonc` contains `"image": "../Dockerfile"` (or equivalent — the rewrite of `./Dockerfile` from `examples/assistant/` to `examples/assistant/dist/`).
   - Run `wrangler deploy --dry-run` from `examples/assistant/`. It should now succeed (or fail only on Docker-related issues unrelated to path resolution — e.g. Docker daemon not running).

2. **`flue build --target cloudflare` for `examples/hello-world`** (no containers field).
   - Confirm output is unchanged in shape — no rewrite happens because there are no relative paths to rewrite.
   - Confirm `wrangler deploy --dry-run` still succeeds.

3. **`flue dev --target cloudflare` for `examples/hello-world`**.
   - Confirm it boots, serves on port 3583, `curl http://localhost:3583/health` returns ok.
   - This validates the `dev.ts` migration didn't break anything in the wrangler config read path.

4. **Both Node target paths (`flue build`, `flue run`, `flue dev` with `--target node`).**
   - These don't go through the wrangler merge code, but they do exercise the SDK as a whole. Sanity-check they're unaffected.

If any of these uncover something the plan missed, the implementer should flag it before pressing on. The plan is based on what we found while debugging, but it's not exhaustive.

## Things to be careful about

- **`experimental_readRawConfig` vs `unstable_readConfig`.** Both are wrangler's recommended primitives, both prefixed to indicate the API can shift. Pick the one that produces output we can use directly. If they behave the same for our case, prefer the simpler one. If the Vite plugin's `preserveOriginalMain: true` option is needed (wrangler's reader normally absolutifies `main` based on the config dir), use `unstable_readConfig` with that flag. We control `main` in our merge — we always set it to `_entry.ts` regardless of what the user wrote — so this may not matter for us.

- **Behavior parity on parse.** Our current `parseJsonc` accepts trailing commas. Wrangler's reader may also accept them but verify with `examples/assistant/wrangler.jsonc` (which has comments) that nothing regresses.

- **Cross-platform path handling.** `path.relative` returns native separators (`\` on Windows). The output JSON should use `/` regardless. Use `.split(path.sep).join('/')` after `path.relative`, or use `path.posix.relative` after normalizing inputs to forward slashes.

- **`mergeFlueAdditions` should NOT change.** We deliberately keep the merge logic — DO bindings dedup by `name`, migration appended only if tag isn't already present, etc. Don't get sucked into rewriting that part. Its tests (such as they are — runtime via examples) work today; keep them working.

- **`validateUserWranglerConfig` should also stay.** It checks Flue-specific minimums (`compatibility_date >= 2026-04-01`, `nodejs_compat` flag present). Wrangler doesn't do these checks; keeping them surfaces friendly errors at build time instead of confusing runtime errors.

- **Sandbox detection (`detectSandboxBindings`, `assertSandboxPackageInstalled`) should also stay.** That's our convention for wiring `@cloudflare/sandbox`, not something wrangler knows about.

## What you might catch that we missed

We tested this plan against the two examples in this repo. There are likely shapes of user wrangler configs we haven't considered. If any of these come up, use your judgment:

- **TOML configs.** We currently reject them. After this change, they should work. We don't have a test fixture for TOML; the implementer can either add one or just verify the wrangler reader handles it without our intervention. Either is fine for v1.
- **Configs with `env` (named environments).** Wrangler supports per-environment overrides. Our current merge doesn't traverse into `env.<name>`. Whether `env.<name>.containers[].image` should also be path-rewritten is a real question. My instinct: handle the top-level case first; add `env.*` traversal when someone hits it. But if the implementer sees this is trivial to do right the first time, do it.
- **Absolute paths in user configs.** Our heuristic is "absolute → leave alone." Verify wrangler still resolves them correctly from the new dist location. Should be fine — wrangler accepts absolute paths — but worth a quick check.
- **The `unstable_readConfig` option `preserveOriginalMain: true`.** Used by the Cloudflare Vite plugin to prevent wrangler from auto-resolving `main` to an absolute path. We may or may not want this; depends on which reader we pick and how it interacts with our merge. If `main` ends up wrong in the output, this is the lever.

## Files that change

- `packages/sdk/src/cloudflare-wrangler-merge.ts` — replace reader, add `rewriteRelativePaths`, drop TOML rejection, drop manual jsonc parsing
- `packages/sdk/src/build-plugin-cloudflare.ts` — call `rewriteRelativePaths` after `mergeFlueAdditions`
- `packages/sdk/src/dev.ts` — migrate `readConfigCompatFields` off `parseJsonc`
- `packages/sdk/package.json` — remove `jsonc-parser` from dependencies (only if all callsites migrate cleanly)
- `packages/sdk/tsdown.config.ts` — verify `wrangler` and `miniflare` are still externalized (they are today; this is just a sanity check)

## Files that should NOT change

- `examples/hello-world/wrangler.jsonc` — keep as-is. It exists to pin `compatibility_date` to a value that works with the bundled workerd version. Removing it would make the build fall back to today's date, which can exceed workerd's supported range.
- `examples/assistant/wrangler.jsonc` — keep as-is. The bug should be fixed by Flue's merge logic, not by asking users to adjust their config.
- Anything in `packages/cli/` — the CLI doesn't touch wrangler config directly.
- The build pipeline (esbuild for Node, no-bundle for Cloudflare). Already correct from prior work.

## Background context worth knowing

In the previous round of work we made a related architectural change: **Flue no longer pre-bundles for the Cloudflare target.** `flue build --target cloudflare` now emits an unbundled `_entry.ts` plus `wrangler.jsonc`, and wrangler does the bundling at `wrangler dev` / `wrangler deploy` time. Background context — useful but not strictly required to do this work:

- The Cloudflare build plugin uses `bundle: 'none'` in its `BuildPlugin` interface (see `packages/sdk/src/types.ts`).
- Generated entry imports user agent files at absolute paths. Wrangler's bundler (esbuild under the hood) handles them correctly.
- `flue dev --target cloudflare` uses `unstable_startWorker({ config: <path-to-dist/wrangler.jsonc> })`. There's a known wrangler quirk we work around in `dev.ts`: `unstable_startWorker` doesn't auto-derive `nodejsCompatMode` from the config's `compatibility_flags`; we read flags ourselves via `miniflare.getNodeCompat` and pass `build.nodejsCompatMode` explicitly. See the comment block in `CloudflareReloader.startWorker` for details.

None of this should change in this round. If something seems to require touching it, that's a signal to stop and discuss.
