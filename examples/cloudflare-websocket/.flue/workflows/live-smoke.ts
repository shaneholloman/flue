import { type FlueContext, websocket } from '@flue/runtime';

export const channels = [websocket()];

export async function run({ payload, log }: FlueContext) {
	const marker = typeof payload === 'object' && payload !== null && 'marker' in payload ? String(payload.marker) : '';
	log.info('cloudflare websocket live smoke', { marker });
	return { echoed: marker };
}
