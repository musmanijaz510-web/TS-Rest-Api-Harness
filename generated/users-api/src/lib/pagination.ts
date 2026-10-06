// Cursor pagination. Cursors are opaque (base64url of the last item's id).
import { z } from 'zod';
import { RequestValidationError } from './validate.ts';

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageQuery = z.output<typeof PageQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export const encodeCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');
export const decodeCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString('utf8');

/** Slice a stably ordered list after the cursor's item. */
export function paginate<T extends { id: string }>(items: readonly T[], query: PageQuery): { data: T[]; nextCursor: string | null } {
  let start = 0;
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    const index = items.findIndex((item) => item.id === after);
    if (index < 0) throw new RequestValidationError('cursor: unknown or expired cursor');
    start = index + 1;
  }
  const data = items.slice(start, start + query.limit);
  const last = data[data.length - 1];
  const nextCursor = last !== undefined && start + query.limit < items.length ? encodeCursor(last.id) : null;
  return { data, nextCursor };
}
