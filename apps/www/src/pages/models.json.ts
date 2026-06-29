import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { APIRoute } from 'astro';

export const GET: APIRoute = () => {
	const modelSpecifiers = getBuiltinProviders().flatMap((provider) =>
		getBuiltinModels(provider).map((model) => `${provider}/${model.id}`),
	);

	if (modelSpecifiers.length === 0) {
		throw new Error('No model specifiers found in the @earendil-works/pi-ai built-in catalog.');
	}

	return new Response(JSON.stringify(modelSpecifiers, null, 2), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
	});
};
