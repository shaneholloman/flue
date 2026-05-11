import { discoverSessionContext } from './context.ts';
import { bashFactoryToSessionEnv, createCwdSessionEnv } from './sandbox.ts';
import { Harness } from './harness.ts';
import { assertRoleExists } from './roles.ts';
import type {
	AgentConfig,
	AgentInit,
	BashFactory,
	BashLike,
	FlueContext,
	FlueEventCallback,
	FlueHarness,
	SandboxFactory,
	SessionEnv,
	SessionStore,
} from './types.ts';

export interface FlueContextConfig {
	id: string;
	runId: string;
	payload: any;
	env: Record<string, any>;
	agentConfig: AgentConfig;
	createDefaultEnv: () => Promise<SessionEnv>;
	createLocalEnv: () => Promise<SessionEnv>;
	defaultStore: SessionStore;
	/**
	 * Platform-specific sandbox resolver hook. Called before default resolution.
	 * Returns SessionEnv to use, or null to fall through to default logic.
	 */
	resolveSandbox?: (sandbox: unknown) => Promise<SessionEnv> | null;
	/**
	 * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
	 * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
	 * points (e.g. future cron triggers) leave it undefined.
	 */
	req?: Request;
}

/** Extends FlueContext with server-only methods. Agent handlers only see FlueContext. */
export interface FlueContextInternal extends FlueContext {
	setEventCallback(callback: FlueEventCallback | undefined): void;
}

export function createFlueContext(config: FlueContextConfig): FlueContextInternal {
	let currentEventCallback: FlueEventCallback | undefined;
	const initializedHarnessNames = new Set<string>();

	const ctx: FlueContextInternal = {
		get id() {
			return config.id;
		},

		get runId() {
			return config.runId;
		},

		get payload() {
			return config.payload;
		},

		get env() {
			return config.env;
		},

		get req() {
			return config.req;
		},

		async init(options?: AgentInit): Promise<FlueHarness> {
			if (!options || !('model' in options)) {
				throw new Error(
					'[flue] init() requires a model. Pass { model: "provider/model-id" } or { model: false }.',
				);
			}
			if (options.model !== false && typeof options.model !== 'string') {
				throw new Error('[flue] init({ model }) must be a model string or false.');
			}

			const name = options.name ?? 'default';
			if (initializedHarnessNames.has(name)) {
				throw new Error(`[flue] init() has already been called with name "${name}" in this request.`);
			}
			initializedHarnessNames.add(name);

			try {
				assertRoleExists(config.agentConfig.roles, options.role);
				const sandbox = options.sandbox;
				const baseEnv = await resolveSessionEnv(config.id, sandbox, config, options.cwd);
				const env = options.cwd ? createCwdSessionEnv(baseEnv, options.cwd) : baseEnv;
				const store: SessionStore = options.persist ?? config.defaultStore;
				const localContext = await discoverSessionContext(env);

				// Harness-level model override. Per-call `model` on prompt()/skill() still wins
				// because resolveModelForCall() applies it on top of this default.
				const agentModel = config.agentConfig.resolveModel(options.model);

				const agentConfig: AgentConfig = {
					...config.agentConfig,
					systemPrompt: localContext.systemPrompt,
					skills: localContext.skills,
					model: agentModel,
					role: options.role ?? config.agentConfig.role,
					thinkingLevel: options.thinkingLevel ?? config.agentConfig.thinkingLevel,
				};

				return new Harness(
					config.id,
					name,
					agentConfig,
					env,
					store,
					currentEventCallback,
					options.tools,
				);
			} catch (error) {
				initializedHarnessNames.delete(name);
				throw error;
			}
		},

		setEventCallback(callback: FlueEventCallback | undefined): void {
			currentEventCallback = callback;
		},
	};

	return ctx;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value: unknown): value is BashLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'exec' in value &&
		'getCwd' in value &&
		'fs' in value &&
		typeof (value as any).exec === 'function' &&
		typeof (value as any).getCwd === 'function' &&
		typeof (value as any).fs === 'object'
	);
}

function isBashFactory(value: unknown): value is BashFactory {
	return typeof value === 'function';
}

function isSandboxFactory(value: unknown): value is SandboxFactory {
	return (
		typeof value === 'object' &&
		value !== null &&
		'createSessionEnv' in value &&
		typeof (value as any).createSessionEnv === 'function'
	);
}

/** Resolve sandbox option to SessionEnv: empty → local → BashFactory → platform hook → SandboxFactory. */
async function resolveSessionEnv(
	id: string,
	sandbox: AgentInit['sandbox'],
	config: FlueContextConfig,
	cwd: string | undefined,
): Promise<SessionEnv> {
	if (sandbox === undefined || sandbox === 'empty') {
		return config.createDefaultEnv();
	}
	if (sandbox === 'local') {
		return config.createLocalEnv();
	}
	if (isBashFactory(sandbox)) {
		return bashFactoryToSessionEnv(sandbox);
	}
	if (isBashLike(sandbox)) {
		throw new Error(
			'[flue] init({ sandbox }) no longer accepts a Bash-like object directly. ' +
				'Pass a BashFactory instead, e.g. `sandbox: () => new Bash({ fs })`.',
		);
	}
	if (config.resolveSandbox) {
		const resolved = await config.resolveSandbox(sandbox);
		if (resolved) return resolved;
	}
	if (isSandboxFactory(sandbox)) {
		return sandbox.createSessionEnv({ id, cwd });
	}
	throw new Error('[flue] Invalid sandbox option passed to init().');
}

// ─── @flue/sdk/client public API ────────────────────────────────────────────

export { Type } from '@mariozechner/pi-ai';
export { connectMcpServer } from './mcp.ts';

export type { McpServerConnection, McpServerOptions, McpTransport } from './mcp.ts';

export type {
	FlueContext,
	FlueHarness,
	FlueFs,
	FlueSessions,
	FlueSession,
	AgentInit,
	ModelConfig,
	FlueEvent,
	FlueEventCallback,
	SessionData,
	SessionStore,
	FileStat,
	SandboxFactory,
	BashFactory,
	BashLike,
	SessionEnv,
	SessionOptions,
	ProviderSettings,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	PromptModel,
	SkillOptions,
	TaskOptions,
	ShellOptions,
	ShellResult,
	ToolDef,
	ToolParameters,
	ThinkingLevel,
} from './types.ts';
