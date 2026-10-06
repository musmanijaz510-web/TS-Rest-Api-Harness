import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';
import { NotePageSchema, NoteSchema } from '../src/notes/schema.ts';
import { resetNotes } from '../src/notes/store.ts';

const json = { 'Content-Type': 'application/json' };
const create = (body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/notes', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) });

beforeEach(() => resetNotes());

test('POST /v1/notes creates a note with 201', async () => {
  const res = await create({ title: 'First', body: 'hello' });
  assert.equal(res.status, 201);
  const note = NoteSchema.parse(await res.json());
  assert.equal(note.title, 'First');
});

test('POST /v1/notes rejects invalid input with a 422 problem', async () => {
  const res = await create({ title: '' });
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const p = ProblemSchema.parse(await res.json());
  assert.match(p.detail, /title/);
  assert.equal(p.instance, '/v1/notes');
});

test('POST /v1/notes rejects malformed JSON with a 422 problem', async () => {
  const res = await app.request('/v1/notes', { method: 'POST', headers: json, body: '{' });
  assert.equal(res.status, 422);
});

test('POST /v1/notes replays on a repeated Idempotency-Key and 409s on a changed body', async () => {
  const first = NoteSchema.parse(await (await create({ title: 'A' }, { 'Idempotency-Key': 'k1' })).json());
  const again = await create({ title: 'A' }, { 'Idempotency-Key': 'k1' });
  assert.equal(again.status, 201);
  assert.equal(NoteSchema.parse(await again.json()).id, first.id);
  const changed = await create({ title: 'B' }, { 'Idempotency-Key': 'k1' });
  assert.equal(changed.status, 409);
});

test('GET /v1/notes pages with a cursor', async () => {
  for (const t of ['a', 'b', 'c']) await create({ title: t });
  const page1 = NotePageSchema.parse(await (await app.request('/v1/notes?limit=2')).json());
  assert.equal(page1.data.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = NotePageSchema.parse(await (await app.request(`/v1/notes?limit=2&cursor=${page1.nextCursor}`)).json());
  assert.deepEqual(page2.data.map((n) => n.title), ['c']);
  assert.equal(page2.nextCursor, null);
});

test('GET /v1/notes/:id returns 404 problem for a missing note and 422 for a bad id', async () => {
  const missing = await app.request('/v1/notes/7d0c7a52-8a43-4e4c-9a4f-0b1f2f7e1c11');
  assert.equal(missing.status, 404);
  assert.equal(ProblemSchema.parse(await missing.json()).status, 404);
  assert.equal((await app.request('/v1/notes/not-a-uuid')).status, 422);
});

test('DELETE /v1/notes/:id returns 204, then 404', async () => {
  const note = NoteSchema.parse(await (await create({ title: 'x' })).json());
  assert.equal((await app.request(`/v1/notes/${note.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await app.request(`/v1/notes/${note.id}`, { method: 'DELETE' })).status, 404);
});
