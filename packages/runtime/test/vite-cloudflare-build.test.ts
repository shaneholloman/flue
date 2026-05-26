import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { build, cloudflareViteConfigPath, cloudflareViteInputDir, createCloudflareViteConfig } from '../../cli/src/lib/build.ts';

describe('Cloudflare Vite production Worker', () => {
	it('builds deployable official-plugin output from the production Cloudflare target', async () => {
		const { root, output } = await createGeneratedFixture('build');
		const inputConfig = JSON.parse(fs.readFileSync(cloudflareViteConfigPath(root), 'utf8')) as { main?: string; durable_objects?: { bindings?: Array<{ class_name: string }> } };
		expect(inputConfig.main).toBe('.flue-vite/_entry.ts');
		expect(inputConfig.durable_objects?.bindings?.map((binding) => binding.class_name)).toEqual(expect.arrayContaining(['Assistant', 'SmokeWorkflow', 'FlueRegistry']));
		const outputConfigs = fs.readdirSync(output, { recursive: true }).filter((entry) => String(entry).endsWith('wrangler.json'));
		expect(outputConfigs).not.toHaveLength(0);
		const deployRedirect = JSON.parse(fs.readFileSync(path.join(root, '.wrangler', 'deploy', 'config.json'), 'utf8')) as { configPath?: string };
		expect(deployRedirect.configPath).toContain('wrangler.json');
		expect(deployRedirect.configPath).not.toContain('wrangler.jsonc');
	}, 90000);

	it('does not retain Cloudflare environment selection after building', async () => {
		const previous = process.env.CLOUDFLARE_ENV;
		delete process.env.CLOUDFLARE_ENV;
		try {
			await createGeneratedFixture('development');
			expect(process.env.CLOUDFLARE_ENV).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.CLOUDFLARE_ENV;
			else process.env.CLOUDFLARE_ENV = previous;
		}
	}, 90000);

	it('preserves the source Worker name when the Vite plugin selects an environment', async () => {
		const previous = process.env.CLOUDFLARE_ENV;
		delete process.env.CLOUDFLARE_ENV;
		const wranglerConfig = {
			name: 'support-seal-flue',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			env: { staging: { name: 'support-seal-flue-staging' } },
		};
		try {
			const production = await createGeneratedFixture('build', { wranglerConfig, cloudflareEnv: null });
			const productionConfigPath = path.join(production.output, 'support_seal_flue', 'wrangler.json');
			expect(JSON.parse(fs.readFileSync(productionConfigPath, 'utf8')).name).toBe('support-seal-flue');
			expect(fs.existsSync(path.join(production.output, 'support_seal_flue_staging'))).toBe(false);

			const staging = await createGeneratedFixture('build', { wranglerConfig, cloudflareEnv: 'staging' });
			const inputConfig = JSON.parse(fs.readFileSync(cloudflareViteConfigPath(staging.root), 'utf8')) as { name: string; env: { staging: { name: string; main: string; durable_objects: { bindings: Array<{ class_name: string }> } } } };
			expect(inputConfig.name).toBe('support-seal-flue');
			expect(inputConfig.env.staging.name).toBe('support-seal-flue-staging');
			expect(inputConfig.env.staging.main).toBe('.flue-vite/_entry.ts');
			expect(inputConfig.env.staging.durable_objects.bindings.map((binding) => binding.class_name)).toEqual(expect.arrayContaining(['Assistant', 'SmokeWorkflow', 'FlueRegistry']));
			const stagingConfigPath = path.join(staging.output, 'support_seal_flue', 'wrangler.json');
			expect(JSON.parse(fs.readFileSync(stagingConfigPath, 'utf8')).name).toBe('support-seal-flue-staging');
			expect(fs.existsSync(path.join(staging.output, 'support_seal_flue_staging'))).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.CLOUDFLARE_ENV;
			else process.env.CLOUDFLARE_ENV = previous;
		}
	}, 90000);

	it('serves workflows and activates packaged skills through workerd in Vite development', async () => {
		const { root } = await createGeneratedFixture('development');
		const entryPath = path.join(cloudflareViteInputDir(root), '_entry.ts');
		const viteConfig = createCloudflareViteConfig(root, cloudflareViteConfigPath(root), [entryPath], { persistState: false });
		const server = await createServer({
			...viteConfig,
			logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0 },
		});
		try {
			await server.listen();
			const localUrl = server.resolvedUrls?.local[0];
			if (!localUrl) throw new Error('Vite server URL unavailable');
			const response = await fetch(new URL('/workflows/smoke?wait=result', localUrl), { method: 'POST' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				result: {
					ok: true,
					reference: { __flueSkillReference: true, name: 'review', description: 'Reviews requested work.' },
					hasBody: false,
					hasFiles: false,
				},
			});
			const skillResponse = await fetch(new URL('/workflows/use-skill?wait=result', localUrl), { method: 'POST' });
			expect(skillResponse.status).toBe(200);
			expect(await skillResponse.json()).toMatchObject({ result: { text: 'License terms.\n' } });
			const namedSkillResponse = await fetch(new URL('/workflows/use-named-skill?wait=result', localUrl), { method: 'POST' });
			expect(namedSkillResponse.status).toBe(200);
			expect(await namedSkillResponse.json()).toMatchObject({ result: { text: 'License terms.\n' } });
		} finally {
			await server.close();
		}
	}, 90000);
});

async function createGeneratedFixture(
	mode: 'build' | 'development',
	options: { wranglerConfig?: Record<string, unknown>; cloudflareEnv?: string | null } = {},
): Promise<{ root: string; output: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-vite-cloudflare-'));
	const output = path.join(root, 'generated');
	fs.mkdirSync(path.join(root, 'node_modules', '@flue'), { recursive: true });
	fs.mkdirSync(path.join(root, 'node_modules', '@earendil-works'), { recursive: true });
	fs.symlinkSync(process.cwd(), path.join(root, 'node_modules', '@flue', 'runtime'), 'dir');
	fs.symlinkSync(path.resolve(process.cwd(), 'node_modules/@earendil-works/pi-ai'), path.join(root, 'node_modules', '@earendil-works', 'pi-ai'), 'dir');
	fs.symlinkSync(
		path.resolve(process.cwd(), '../../examples/cloudflare-websocket/node_modules/agents'),
		path.join(root, 'node_modules', 'agents'),
		'dir',
	);
	fs.mkdirSync(path.join(root, 'agents'));
	fs.mkdirSync(path.join(root, 'workflows'));
	fs.mkdirSync(path.join(root, 'skills', 'review'), { recursive: true });
	fs.writeFileSync(path.join(root, 'wrangler.jsonc'), JSON.stringify(options.wranglerConfig ?? { name: 'vite-cloudflare-integration', compatibility_date: '2026-04-01', compatibility_flags: ['nodejs_compat'] }));
	if (options.cloudflareEnv !== null) {
		fs.writeFileSync(path.join(root, mode === 'development' ? '.env.development' : '.env.production'), `CLOUDFLARE_ENV=${options.cloudflareEnv ?? 'fixture-env'}\n`);
	}
	fs.writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: Reviews requested work.\n---\nReview it.\n`);
	fs.writeFileSync(path.join(root, 'skills', 'review', 'LICENSE.txt'), 'License terms.\n');
	fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), `import { createAgent } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport default createAgent(() => ({ model: 'fixture/reader', skills: [review] }));\n`);
	fs.writeFileSync(path.join(root, 'workflows', 'smoke.ts'), `import { http } from '@flue/runtime';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const channels = [http()];\nexport async function run() { return { ok: true, reference: review, hasBody: 'body' in review, hasFiles: 'files' in review }; }\n`);
	fs.writeFileSync(path.join(root, 'workflows', 'use-skill.ts'), `import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai';\nimport { createAgent, http, type FlueContext } from '@flue/runtime';\nimport { registerProvider } from '@flue/runtime/app';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const channels = [http()];\nconst agent = createAgent(() => ({ model: 'fixture/reader' }));\nexport async function run({ init }: FlueContext) { const faux = registerFauxProvider({ api: 'fixture-skill-api', provider: 'fixture' }); registerProvider('fixture', { api: faux.api, baseUrl: 'https://fixture.invalid' }); faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: '/.flue/packaged-skills/' + encodeURIComponent(review.id) + '/LICENSE.txt' }), { stopReason: 'toolUse' }), (context) => { const toolResult = context.messages[context.messages.length - 1]; const content = toolResult?.role === 'toolResult' && toolResult.content[0]?.type === 'text' ? toolResult.content[0].text : 'missing packaged content'; return fauxAssistantMessage(fauxText(content)); }]); const harness = await init(agent); const session = await harness.session(); const result = await session.skill(review); faux.unregister(); return { text: result.text }; }\n`);
	fs.writeFileSync(path.join(root, 'workflows', 'use-named-skill.ts'), `import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai';\nimport { createAgent, http, type FlueContext } from '@flue/runtime';\nimport { registerProvider } from '@flue/runtime/app';\nimport review from '../skills/review/SKILL.md' with { type: 'skill' };\nexport const channels = [http()];\nconst agent = createAgent(() => ({ model: 'fixture/reader', skills: [review] }));\nexport async function run({ init }: FlueContext) { const faux = registerFauxProvider({ api: 'fixture-named-skill-api', provider: 'fixture' }); registerProvider('fixture', { api: faux.api, baseUrl: 'https://fixture.invalid' }); faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: '/.flue/packaged-skills/' + encodeURIComponent(review.id) + '/LICENSE.txt' }), { stopReason: 'toolUse' }), (context) => { const toolResult = context.messages[context.messages.length - 1]; const content = toolResult?.role === 'toolResult' && toolResult.content[0]?.type === 'text' ? toolResult.content[0].text : 'missing packaged content'; return fauxAssistantMessage(fauxText(content)); }]); const harness = await init(agent); const session = await harness.session(); const result = await session.skill('review'); faux.unregister(); return { text: result.text }; }\n`);
	await build({ root, output, target: 'cloudflare', mode });
	return { root, output };
}
