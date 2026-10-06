import { serve } from '@hono/node-server';
import { z } from 'zod';
import { app } from './app.ts';

const port = z.coerce.number().int().min(1).max(65535).default(3000).parse(process.env.PORT);
serve({ fetch: app.fetch, port });
console.log(`listening on http://localhost:${port}`);
