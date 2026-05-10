/**
 * Node-specific entry point for `@flue/sdk`. Exports node-only helpers
 * such as `createLocalSessionEnv`.
 *
 * Import platform-agnostic types (`FlueContext`, etc.) from
 * `@flue/sdk/client`.
 */
export { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';
