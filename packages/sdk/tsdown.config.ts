import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/client.ts',
		'src/sandbox.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/node/index.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	// `wrangler` and `miniflare` are heavy peer/optional deps that the dev
	// server lazy-imports at runtime. Keep them external so the SDK bundle
	// stays small (saves ~5 MB).
	external: ['wrangler', 'miniflare'],
});
