/**
 * Merge Flue's Cloudflare additions into the user's wrangler config.
 *
 * Philosophy: the user's wrangler config is the source of truth. Flue contributes
 * the pieces it owns (the Worker entrypoint, its per-agent Durable Object
 * bindings, the Sandbox DO, the migration tag) and leaves everything else
 * untouched. The merged result is written to `dist/wrangler.jsonc` so the
 * deployed Worker sees both.
 *
 * We delegate parsing and normalization to wrangler's own `unstable_readConfig`
 * (lazy-imported so Node-only Flue users don't pay for it). This gets us:
 *   - Both jsonc and TOML support for free.
 *   - Wrangler's own validation diagnostics (clearer errors than ours).
 *   - Path normalization: relative paths in fields like `containers[].image`
 *     are resolved to absolute paths against the user's config dir before
 *     we merge. This is critical because we write the merged config to
 *     `dist/wrangler.jsonc` — wrangler resolves relative paths against the
 *     config file's own directory, so without normalization a user's
 *     `containers[].image: "./Dockerfile"` would resolve to `dist/Dockerfile`
 *     after the move and fail to deploy.
 *
 * Flue still owns merge semantics (DO binding de-dup by `name`, migration
 * append-if-tag-absent) and Flue-specific validation (compat date floor,
 * required compat flags) — wrangler doesn't know about those.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Unstable_Config } from 'wrangler';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Minimum compatibility_date Flue supports. */
const MIN_COMPATIBILITY_DATE = '2026-04-01';

/** compatibility_flag Flue requires for pi-ai's process.env-based API key lookup. */
const REQUIRED_COMPAT_FLAG = 'nodejs_compat';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A Flue-owned DO binding for a webhook agent (or the Sandbox class). */
export interface DoBinding {
	class_name: string;
	name: string;
}

/** A migration entry Flue contributes (SQLite class creation for its agents). */
export interface Migration {
	tag: string;
	new_sqlite_classes: string[];
}

/**
 * Everything Flue contributes to the wrangler config.
 *
 * Flue contributes only the per-agent DO bindings (one per webhook agent) and
 * their migration entry. Everything else — user Durable Object bindings (e.g.
 * Sandbox), container entries, migrations for user DO classes — belongs to the
 * user's own wrangler.jsonc and is passed through untouched during merge.
 */
export interface FlueAdditions {
	/** Fallback name if the user didn't set one in their wrangler config. */
	defaultName: string;
	/** Always written; Flue owns the bundle entrypoint. */
	main: string;
	/** Flue's per-agent DO bindings. Merged into durable_objects.bindings by `name`. */
	doBindings: DoBinding[];
	/** Flue's migration entry (per-agent classes). Appended only if no existing entry has the same tag. */
	migration: Migration;
}

// ─── Reading user config ────────────────────────────────────────────────────

interface UserConfigRead {
	/**
	 * Normalized config from wrangler's reader, or an empty object if no user
	 * file was found. Treated as `Record<string, unknown>` at our merge layer
	 * because we touch only a handful of well-known fields and pass everything
	 * else through unchanged. Typed loosely so we can survive shape drift in
	 * wrangler's `Unstable_Config` between minor versions.
	 */
	config: Record<string, unknown>;
	/** Absolute path of the user config file that was read, or null if none existed. */
	path: string | null;
}

/**
 * Read and normalize the user's wrangler config from `outputDir`.
 *
 * Looks for `wrangler.jsonc`, `wrangler.json`, then `wrangler.toml` (jsonc is
 * Cloudflare's recommended format for new projects, but all three work).
 * Returns an empty config if no file is present.
 *
 * Delegates parsing + normalization to wrangler via `unstable_readConfig`. This
 * is async only because wrangler is a lazy import (it's a peer dep — Flue users
 * who only target Node should not pay for resolving it). The wrangler call
 * itself is synchronous under the hood.
 *
 * The returned config has been through wrangler's `normalizeAndValidateConfig`,
 * which:
 *   - Resolves relative paths to absolute (notably `containers[].image`).
 *   - Fills in defaults (`compatibility_date` if absent, etc.).
 *   - Merges `env.*` per-environment overrides.
 *   - Throws on validation errors via wrangler's own `UserError`.
 *
 * The verbose / defaulted output is intentional — the cost is a slightly bigger
 * `dist/wrangler.jsonc` and the benefit is correctness without us reimplementing
 * wrangler's path-resolution logic.
 */
export async function readUserWranglerConfig(outputDir: string): Promise<UserConfigRead> {
	const candidates = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
	let foundPath: string | null = null;
	for (const name of candidates) {
		const candidate = path.join(outputDir, name);
		if (fs.existsSync(candidate)) {
			foundPath = candidate;
			break;
		}
	}

	if (!foundPath) {
		return { config: {}, path: null };
	}

	let wrangler: typeof import('wrangler');
	try {
		wrangler = (await import('wrangler')) as typeof import('wrangler');
	} catch (err) {
		throw new Error(
			`[flue] Reading the Cloudflare wrangler config requires the "wrangler" package as a peer dependency.\n` +
				`Install it in your project:\n\n` +
				`  npm install --save-dev wrangler\n\n` +
				`Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	let parsed: Unstable_Config;
	try {
		parsed = wrangler.unstable_readConfig({ config: foundPath }, { hideWarnings: true });
	} catch (err) {
		// Wrangler throws `UserError` for validation/parse failures with an
		// already-formatted message. Re-prefix for friendliness so the user
		// can tell who's complaining.
		throw new Error(
			`[flue] Failed to read ${foundPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return { config: parsed as unknown as Record<string, unknown>, path: foundPath };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate that the user's wrangler config meets Flue's minimum runtime
 * requirements. Throws a clear error describing the fix if it doesn't.
 *
 * We're intentionally strict here rather than silently massaging bad configs —
 * the failure modes when these are wrong (missing nodejs_compat, old
 * compat_date) produce confusing runtime errors, and surfacing the problem at
 * build time is much friendlier.
 *
 * Together with `mergeFlueAdditions`, this enforces two invariants on every
 * Flue worker:
 *   1. `nodejs_compat` is in `compatibility_flags` (added if missing).
 *   2. `compatibility_date >= MIN_COMPATIBILITY_DATE` (defaulted if missing).
 *
 * Those invariants are what let `dev.ts` hardcode `nodejsCompatMode: 'v2'`
 * without re-deriving it from the config on every reload.
 */
export function validateUserWranglerConfig(config: Record<string, unknown>): void {
	// compatibility_flags must include nodejs_compat if user set the field.
	// (If unset, Flue adds it during merge — handled in mergeFlueAdditions.)
	if (Array.isArray(config.compatibility_flags)) {
		const flags = config.compatibility_flags as unknown[];
		if (!flags.includes(REQUIRED_COMPAT_FLAG)) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_flags" is missing "${REQUIRED_COMPAT_FLAG}". ` +
					`Flue relies on it at runtime (e.g. for API key resolution via process.env). ` +
					`Add "${REQUIRED_COMPAT_FLAG}" to the list.`,
			);
		}
	}

	// compatibility_date must be on or after the minimum, if set.
	if (typeof config.compatibility_date === 'string') {
		const userDate = config.compatibility_date;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(userDate)) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_date" ("${userDate}") is not in YYYY-MM-DD format.`,
			);
		}
		if (userDate < MIN_COMPATIBILITY_DATE) {
			throw new Error(
				`[flue] Your wrangler config's "compatibility_date" is "${userDate}". ` +
					`Flue requires at least "${MIN_COMPATIBILITY_DATE}" for SQLite-backed Durable Object support, nodejs_compat v2, and AsyncLocalStorage. ` +
					`Bump the date (set it to today unless you have a specific reason).`,
			);
		}
	}
}

// ─── Merging ────────────────────────────────────────────────────────────────

/**
 * Produce the merged wrangler config: start from the user's, layer Flue's
 * contributions on top. Pure function — caller handles reading and writing.
 */
export function mergeFlueAdditions(
	userConfig: Record<string, unknown>,
	additions: FlueAdditions,
): Record<string, unknown> {
	// Shallow clone so we don't mutate the user's parsed config in place.
	const merged: Record<string, unknown> = { ...userConfig };

	// main: Flue always wins. Flue owns the bundle at dist/server.mjs, and
	// pointing main elsewhere would mean wrangler deploys something Flue didn't
	// build. If the user had a conflicting main, they're now using Flue and
	// should accept this.
	merged.main = additions.main;

	// name: user wins if set; fall back to the default we derive from outputDir.
	if (typeof merged.name !== 'string' || merged.name.length === 0) {
		merged.name = additions.defaultName;
	}

	// compatibility_date: user wins if set; fall back to Flue's known-good
	// minimum. (validateUserWranglerConfig already ensured any user-set value
	// meets Flue's minimum.)
	//
	// We deliberately do NOT default to "today's date". A user running an
	// older Flue install gets a workerd version that's pinned via wrangler;
	// "today" can be ahead of that workerd's supported compat range and
	// produce a confusing "compatibility_date is in the future" error. The
	// floor is conservative but correct for any Flue release.
	if (typeof merged.compatibility_date !== 'string') {
		merged.compatibility_date = MIN_COMPATIBILITY_DATE;
	}

	// compatibility_flags: union with nodejs_compat. (validateUserWranglerConfig
	// already rejected arrays that were set but missing nodejs_compat.)
	const existingFlags = Array.isArray(merged.compatibility_flags)
		? (merged.compatibility_flags as unknown[]).filter((f): f is string => typeof f === 'string')
		: [];
	if (!existingFlags.includes(REQUIRED_COMPAT_FLAG)) {
		existingFlags.push(REQUIRED_COMPAT_FLAG);
	}
	merged.compatibility_flags = existingFlags;

	// durable_objects.bindings: concat user + Flue, de-dupe by `name` (user
	// wins on conflict — they may be overriding a class_name intentionally).
	const existingDo =
		typeof merged.durable_objects === 'object' && merged.durable_objects !== null
			? (merged.durable_objects as Record<string, unknown>)
			: {};
	const existingBindings = Array.isArray(existingDo.bindings)
		? (existingDo.bindings as unknown[])
		: [];
	const existingBindingNames = new Set(
		existingBindings
			.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
			.map((b) => b.name)
			.filter((n): n is string => typeof n === 'string'),
	);
	const flueBindingsToAdd = additions.doBindings.filter((b) => !existingBindingNames.has(b.name));
	merged.durable_objects = {
		...existingDo,
		bindings: [...existingBindings, ...flueBindingsToAdd],
	};

	// migrations: append Flue's migration entry only if no existing entry has
	// the same tag. Migration order matters to wrangler, so we append rather
	// than prepend — user's historical migrations come first, Flue's new
	// tagged entry comes last.
	const existingMigrations = Array.isArray(merged.migrations)
		? (merged.migrations as unknown[])
		: [];
	const existingMigrationTags = new Set(
		existingMigrations
			.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
			.map((m) => m.tag)
			.filter((t): t is string => typeof t === 'string'),
	);
	const migrationsOut = [...existingMigrations];
	if (!existingMigrationTags.has(additions.migration.tag)) {
		migrationsOut.push(additions.migration);
	}
	merged.migrations = migrationsOut;

	// containers: user owns the `containers` array entirely. Flue contributes
	// nothing here — any entries the user declared pass through untouched via
	// the shallow `{ ...userConfig }` clone above. Nothing to merge.

	return merged;
}

// ─── Sandbox binding detection ──────────────────────────────────────────────

/**
 * Return the list of `class_name`s declared in the user's wrangler
 * `durable_objects.bindings` that contain the literal substring `Sandbox`
 * (case-sensitive).
 *
 * This is Flue's convention for wiring `@cloudflare/sandbox`: any DO binding
 * whose class name contains `Sandbox` triggers an automatic re-export in the
 * generated Worker entry:
 *
 *   export { Sandbox as <class_name> } from '@cloudflare/sandbox';
 *
 * The alias lets users pick arbitrary class names (e.g. `PyBoxSandbox`,
 * `SupportSandbox`) while still pointing at the single class shipped by the
 * `@cloudflare/sandbox` package. Each distinct `class_name` can be paired with
 * a different container image in the user's `containers[]` config.
 *
 * Returns unique, sorted class names. Non-object bindings or bindings without
 * a string `class_name` are ignored.
 */
export function detectSandboxBindings(userConfig: Record<string, unknown>): string[] {
	const doObj = userConfig.durable_objects;
	if (typeof doObj !== 'object' || doObj === null) return [];
	const bindings = (doObj as Record<string, unknown>).bindings;
	if (!Array.isArray(bindings)) return [];

	const found = new Set<string>();
	for (const entry of bindings) {
		if (typeof entry !== 'object' || entry === null) continue;
		const className = (entry as Record<string, unknown>).class_name;
		if (typeof className !== 'string') continue;
		if (className.includes('Sandbox')) found.add(className);
	}
	return Array.from(found).sort();
}

// ─── @cloudflare/sandbox install check ──────────────────────────────────────

/**
 * When the user has declared one or more `Sandbox`-named DO bindings, verify
 * that `@cloudflare/sandbox` is declared in the nearest package.json. Surfaces
 * a friendly, actionable error at build time rather than letting esbuild emit
 * a confusing module-resolution failure.
 *
 * The check is lenient: if no package.json can be located or parsed, we skip
 * silently and let esbuild's own error path take over. This avoids false
 * positives in unusual project layouts.
 */
export function assertSandboxPackageInstalled(
	sandboxClassNames: string[],
	searchDirs: string[],
): void {
	if (sandboxClassNames.length === 0) return;

	for (const dir of searchDirs) {
		let current = dir;
		while (current !== path.dirname(current)) {
			const pkgPath = path.join(current, 'package.json');
			if (fs.existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
					const allDeps = {
						...(pkg.dependencies ?? {}),
						...(pkg.devDependencies ?? {}),
						...(pkg.peerDependencies ?? {}),
						...(pkg.optionalDependencies ?? {}),
					};
					if ('@cloudflare/sandbox' in allDeps) return;
					// Found a package.json but no dep — keep walking in case
					// this is a nested package and the dep is declared higher up
					// (e.g. pnpm workspace root).
				} catch {
					return; // unparseable package.json — give up, let esbuild speak
				}
			}
			current = path.dirname(current);
		}
	}

	throw new Error(
		`[flue] Your wrangler config declares DO binding(s) whose class_name contains "Sandbox" ` +
			`(${sandboxClassNames.join(', ')}), but @cloudflare/sandbox is not in your package.json. ` +
			`Install it: \`npm install @cloudflare/sandbox\`.`,
	);
}

// ─── Deploy redirect file ───────────────────────────────────────────────────

/**
 * Write the wrangler deploy-redirect file at `<outputDir>/.wrangler/deploy/config.json`
 * so that `wrangler deploy` run from `outputDir` automatically picks up the
 * generated `dist/wrangler.jsonc`.
 *
 * This is wrangler's own native redirection mechanism (the same one Astro's
 * Cloudflare adapter uses). We only write the file if one doesn't already
 * exist — if the user has set one up, respect their intent.
 */
export function writeDeployRedirectIfMissing(outputDir: string): void {
	const redirectDir = path.join(outputDir, '.wrangler', 'deploy');
	const redirectPath = path.join(redirectDir, 'config.json');

	if (fs.existsSync(redirectPath)) {
		return;
	}

	fs.mkdirSync(redirectDir, { recursive: true });
	// The redirect file lives at outputDir/.wrangler/deploy/config.json, and
	// wrangler resolves `configPath` relative to that file's directory. So
	// `../../dist/wrangler.jsonc` points at outputDir/dist/wrangler.jsonc.
	fs.writeFileSync(
		redirectPath,
		JSON.stringify({ configPath: '../../dist/wrangler.jsonc' }, null, 2) + '\n',
		'utf-8',
	);
}
