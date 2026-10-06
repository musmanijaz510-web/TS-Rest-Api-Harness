import { z } from 'zod';
import { pageSchema } from '../lib/pagination.ts';

export const NoteSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
  createdAt: z.iso.datetime(),
});
export type Note = z.output<typeof NoteSchema>;

export const CreateNoteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000).default(''),
});

export const NoteParamsSchema = z.object({ id: z.uuid() });
export const NotePageSchema = pageSchema(NoteSchema);
