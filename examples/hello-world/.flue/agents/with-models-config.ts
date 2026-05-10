import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

/**
 * Smoke-test agent for the `models` config field. Verifies that
 * `init({ model: 'ollama/...' })` resolves through the user-defined entry
 * in `flue.config.ts` instead of the pi-ai catalog.
 *
 * We don't actually call the model — running this against a live Ollama
 * instance is a separate manual test. The `init()` call is enough to
 * exercise the resolution path and would throw `Unknown model "ollama/..."`
 * pre-feature.
 */
export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'ollama/llama3.1:8b' });
	const session = await agent.session();
	return {
		ok: true,
		// `session.model` isn't a public field, so we just confirm we got
		// past `init()` and the session was constructed.
		hasSession: typeof session === 'object',
	};
}
