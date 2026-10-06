import { Hono } from 'hono';
import { IdempotencyConflictError } from './lib/idempotency.ts';
import { problem } from './lib/problem.ts';
import { RequestValidationError } from './lib/validate.ts';
import { registerUserRoutes } from './users.ts';

export const app = new Hono();

registerUserRoutes(app);

app.notFound((c) => problem(c, 404, `No route for ${c.req.method} ${new URL(c.req.url).pathname}`));

app.onError((err, c) => {
  if (err instanceof RequestValidationError) return problem(c, 422, err.detail);
  if (err instanceof IdempotencyConflictError) return problem(c, 409, err.message);
  return problem(c, 500, 'Unexpected error');
});
