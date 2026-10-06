// Idempotency keys for unsafe retries (POST). Same key + same payload replays the
// stored response; same key + different payload is a 409 (mapped in app.onError).
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import { parseRequest } from './validate.ts';

export const IdempotencyKeySchema = z.string().trim().min(1).max(255).optional();

const StoredSchema = z.object({ fingerprint: z.string(), body: z.unknown() });
const store = new Map<string, z.output<typeof StoredSchema>>();

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency-Key "${key}" was already used with a different request body`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Reads and validates the Idempotency-Key header. */
export function idempotencyKey(c: Context): Promise<string | undefined> {
  return parseRequest(IdempotencyKeySchema, c.req.header('Idempotency-Key'));
}

const fingerprint = (payload: unknown): string => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/** The stored response body for a retried request, or undefined for a new one. */
export function recall(scope: string, key: string | undefined, payload: unknown): unknown {
  if (key === undefined) return undefined;
  const hit = store.get(`${scope}:${key}`);
  if (hit === undefined) return undefined;
  if (hit.fingerprint !== fingerprint(payload)) throw new IdempotencyConflictError(key);
  return hit.body;
}

export function remember(scope: string, key: string | undefined, payload: unknown, body: unknown): void {
  if (key === undefined) return;
  store.set(`${scope}:${key}`, StoredSchema.parse({ fingerprint: fingerprint(payload), body }));
}
