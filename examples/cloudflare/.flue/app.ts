/**
 * Optional `app.ts` entry. When present, the Flue build delegates the
 * entire request pipeline to whatever this file's default export
 * exposes via `.fetch(request, env, ctx)`.
 *
 * The same `app.ts` shape works on both Node and Cloudflare targets;
 * `flue()` adapts internally. On Cloudflare the agent route forwards to
 * the per-agent Durable Object via the Agents SDK; everything else is
 * just a Hono app.
 *
 * Delete this file and the build falls back to a default app that
 * mounts `flue()` at root with no extras.
 */
import { flue } from '@flue/sdk/app';
import { Hono } from 'hono';

const app = new Hono();

// Custom route — runs in the worker isolate, NOT inside an agent's
// Durable Object. Useful for liveness probes, status pages, or any
// endpoint that doesn't need agent state / streaming.
app.get('/api/ping', (c) => c.json({ pong: true, at: new Date().toISOString() }));

// Flue's built-in agent route: `POST /agents/:name/:id`. Forwards into
// the appropriate per-agent DO via routeAgentRequest().
app.route('/', flue());

export default app;
