import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/deprecated.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
});
