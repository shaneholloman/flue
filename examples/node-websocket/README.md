# Node WebSocket Example

This example exposes a long-lived created-agent socket and a one-shot workflow socket using Flue's generated Node server.

```bash
export ANTHROPIC_API_KEY="..."
pnpm exec flue dev
```

Connect with the SDK from a browser or Node 22+ client:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });
const chat = client.agents.connect('chat', 'customer-123');
await chat.ready;
chat.onEvent((event) => console.log(event));
console.log(await chat.prompt('Hello', { session: 'support' }));
console.log(await chat.prompt('What did I just ask?', { session: 'support' }));
chat.close();

const summarize = client.workflows.connect('summarize');
await summarize.ready;
console.log(await summarize.invoke({ text: 'Flue agents can be reached over WebSockets.' }));
```

Agent sockets remain open for sequential prompts; workflow sockets accept one invocation and close after their result. For production authentication or a mounted prefix, add `.flue/app.ts`, apply ordinary Hono middleware to every exposed agent/workflow socket path, and mount `flue()` beneath that prefix. Without a custom app, protect production sockets through an authenticated upstream gateway or proxy.
