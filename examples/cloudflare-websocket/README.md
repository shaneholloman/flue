# Cloudflare WebSocket Example

This example is the live Cloudflare WebSocket fixture. It mounts `flue()` below `/api`, rejects socket upgrades without its test token in `.flue/app.ts`, exposes a Durable Object-backed `chat` agent, and exposes a model-free `live-smoke` workflow for integration testing.

## Live smoke test

From the repository root:

```bash
pnpm --filter @flue/runtime build
pnpm --filter @flue/cli build
pnpm exec bgproc start -n flue-cf-ws-live --wait-for-port 10 --force -- \
  pnpm --dir ./examples/cloudflare-websocket exec flue dev --target cloudflare --port 3584
FLUE_WS_BASE_URL=http://localhost:3584 \
  pnpm --dir ./examples/cloudflare-websocket run test:live
pnpm exec bgproc stop -n flue-cf-ws-live
```

The live client verifies that unauthenticated agent and workflow upgrades are rejected, an authenticated agent socket is accepted and responds to protocol-level `ping`, and an authenticated workflow socket invokes its handler, returns a result, and closes normally. The smoke deliberately does not issue an agent prompt because that would require Workers AI inference; the workflow provides deterministic operation/result coverage without an API key or model cost.

## Agent connection

The `chat` agent uses Workers AI for real prompts. Because this fixture uses a custom `/api` mount and a test query-token middleware, connect directly to:

```txt
ws://localhost:3584/api/agents/chat/customer-123?token=live-test
```

The stable instance id selects the same Durable Object-backed agent scope. The generated Cloudflare transport accepts hibernation-compatible sockets inside that owning Durable Object.

The SDK currently builds canonical root-mounted socket paths; custom mounted-prefix SDK configuration is a separate follow-up. Use a direct `WebSocket` client for this fixture's `/api` routes.

Deploy with:

```bash
pnpm exec flue build --target cloudflare
pnpm exec wrangler deploy
```

Replace the test query-token middleware with application authentication before deploying this example publicly.
