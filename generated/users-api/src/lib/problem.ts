// RFC 7807 problem responses. Every non-2xx response in this API goes through problem().
import type { Context } from 'hono';
import { z } from 'zod';

const PROBLEMS = {
  400: { slug: 'bad-request', title: 'Bad request' },
  404: { slug: 'not-found', title: 'Resource not found' },
  409: { slug: 'conflict', title: 'Conflict with the current state of the resource' },
  422: { slug: 'validation', title: 'Request failed validation' },
  500: { slug: 'internal', title: 'Internal server error' },
} as const;

export type ProblemStatus = keyof typeof PROBLEMS;

export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
});

export function problem(c: Context, status: ProblemStatus, detail: string): Response {
  const { slug, title } = PROBLEMS[status];
  const body = ProblemSchema.parse({
    type: `https://api.sf/problems/${slug}`,
    title,
    status,
    detail,
    instance: new URL(c.req.url).pathname,
  });
  return c.body(JSON.stringify(body), status, { 'Content-Type': 'application/problem+json' });
}
