// Requires `"ai": { "binding": "AI" }` in wrangler.jsonc. Cloudflare-only:
// the `cloudflare/` prefix throws a clear error on `--target node`.
import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	// Suffix after `cloudflare/` is forwarded to `env.AI.run()` verbatim;
	// unknown ids fail at the binding. Catalog:
	// https://developers.cloudflare.com/workers-ai/models/
	const agent = await init({ model: 'cloudflare/@cf/moonshotai/kimi-k2.6' });
	const session = await agent.session();

	const response = await session.prompt('Say hello in exactly three words.');
	console.log('[with-cloudflare-binding] response:', response.text);
	console.log('[with-cloudflare-binding] tokens:', response.usage.totalTokens);

	return { text: response.text };
}
