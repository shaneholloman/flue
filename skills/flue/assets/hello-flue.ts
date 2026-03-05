import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

// Optional: Define expected input arguments
export const args = v.object({
	name: v.optional(v.string(), 'Flue'),
});

export default async function hello(flue: FlueClient, args: v.InferOutput<typeof args>) {
	// Use shell command to print greeting
	await flue.shell(`echo "Hello from ${args.name}!"`);

	// Use AI prompt to generate a fun fact
	const fact = await flue.prompt(
		`Generate a short, interesting fun fact about software automation or CI/CD pipelines.`,
		{ result: v.string() },
	);

	// Print the fun fact
	await flue.shell(`echo "Fun fact: ${fact}"`);
}
