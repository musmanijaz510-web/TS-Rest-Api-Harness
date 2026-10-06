import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { idempotencyKey, recall, remember } from '../lib/idempotency.ts';
import { PageQuerySchema, paginate } from '../lib/pagination.ts';
import { problem } from '../lib/problem.ts';
import { parseRequest } from '../lib/validate.ts';
import { CreateNoteSchema, NotePageSchema, NoteParamsSchema, NoteSchema, PatchNoteSchema } from './schema.ts';
import { deleteNote, findNote, listNotes, saveNote } from './store.ts';

export function registerNoteRoutes(app: Hono): void {
  app.get('/v1/notes', async (c) => {
    const query = await parseRequest(PageQuerySchema, c.req.query());
    return c.json(NotePageSchema.parse(paginate(listNotes(), query)));
  });

  app.post('/v1/notes', async (c) => {
    const key = await idempotencyKey(c);
    const input = await parseRequest(CreateNoteSchema, c.req.json());
    const replayed = recall('notes', key, input);
    if (replayed !== undefined) return c.json(NoteSchema.parse(replayed), 201);
    const note = saveNote({ id: randomUUID(), ...input, createdAt: new Date().toISOString() });
    remember('notes', key, input, note);
    return c.json(NoteSchema.parse(note), 201);
  });

  app.get('/v1/notes/:id', async (c) => {
    const { id } = await parseRequest(NoteParamsSchema, c.req.param());
    const note = findNote(id);
    if (!note) return problem(c, 404, `Note ${id} not found`);
    return c.json(NoteSchema.parse(note));
  });

  app.patch('/v1/notes/:id', async (c) => {
    const { id } = await parseRequest(NoteParamsSchema, c.req.param());
    const input = await parseRequest(PatchNoteSchema, c.req.json());
    const note = findNote(id);
    if (!note) return problem(c, 404, `Note ${id} not found`);
    const updated = saveNote({ ...note, ...input });
    return c.json(NoteSchema.parse(updated));
  });

  app.delete('/v1/notes/:id', async (c) => {
    const { id } = await parseRequest(NoteParamsSchema, c.req.param());
    if (!deleteNote(id)) return problem(c, 404, `Note ${id} not found`);
    return c.body(null, 204);
  });
}
