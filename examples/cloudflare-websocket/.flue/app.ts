import { flue } from '@flue/runtime/app';
import { Hono, type MiddlewareHandler } from 'hono';

const authorizeSocket: MiddlewareHandler = async (c, next) => {
	if (c.req.query('token') !== 'live-test') return c.text('Unauthorized', 401);
	await next();
};

const app = new Hono();

app.use('/api/agents/*', authorizeSocket);
app.use('/api/workflows/*', authorizeSocket);
app.route('/api', flue());

export default app;
