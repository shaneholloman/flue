import { defineConfig, defineOpenAICompletionsModel } from '@flue/sdk/config';

/**
 * Example `flue.config.ts` demonstrating user-defined model providers.
 *
 * The `models` map declares additional `provider/...` namespaces that
 * `init({ model: '...' })` resolves. Each entry is a bare provider name
 * (no slash) → a model-definition record from a `defineXxxModel` helper.
 *
 * Once registered, agent code can do:
 *
 *     init({ model: 'ollama/llama3.1:8b' })
 *
 * The part after the first slash (`llama3.1:8b`) is forwarded to the
 * underlying OpenAI-compatible endpoint as the model id.
 *
 * `target` is intentionally left unset here so existing `--target node`
 * invocations in this example keep working unchanged.
 */
export default defineConfig({
	models: {
		// Local Ollama (https://ollama.com). Start with `ollama serve`, pull a
		// model with `ollama pull llama3.1:8b`, then run agents with
		// `init({ model: 'ollama/llama3.1:8b' })`.
		ollama: defineOpenAICompletionsModel({
			baseUrl: 'http://localhost:11434/v1',
		}),
		// LM Studio (https://lmstudio.ai). Same pattern: start the local
		// server, then `init({ model: 'lmstudio/<loaded-model-id>' })`.
		lmstudio: defineOpenAICompletionsModel({
			baseUrl: 'http://localhost:1234/v1',
		}),
	},
});
