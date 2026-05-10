/**
 * Node-specific entry point for `@flue/sdk`. Exports node-only helpers
 * such as `defineCommand` and `createLocalSessionEnv`.
 *
 * Import platform-agnostic types (`FlueContext`, `Command`, etc.) from
 * `@flue/sdk/client`.
 */
export { defineCommand, type CommandOptions } from './define-command.ts';
export { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';
