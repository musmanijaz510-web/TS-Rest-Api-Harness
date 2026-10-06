import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

async function json(res: Response): Promise<unknown> {
  return res.status === 204 ? undefined : res.json();
}

test('POST /v1/users creates users and rejects duplicate emails', async () => {
  const created = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', name: 'Ada Lovelace', role: 'admin' }),
  });

  assert.equal(created.status, 201);
  const body = await json(created);
  assert.equal(typeof body, 'object');
  assert.notEqual(body, null);
  assert.equal((body as { email?: unknown }).email, 'ada@example.com');
  assert.equal((body as { name?: unknown }).name, 'Ada Lovelace');
  assert.equal((body as { role?: unknown }).role, 'admin');
  assert.equal(typeof (body as { id?: unknown }).id, 'string');
  assert.equal(typeof (body as { createdAt?: unknown }).createdAt, 'string');

  const duplicate = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', name: 'Someone Else' }),
  });

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.headers.get('content-type'), 'application/problem+json');
  assert.equal(ProblemSchema.parse(await duplicate.json()).status, 409);
});

test('POST /v1/users honours Idempotency-Key', async () => {
  const first = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'create-grace' },
    body: JSON.stringify({ email: 'grace@example.com', name: 'Grace Hopper' }),
  });
  const firstBody = await first.json();

  const replay = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'create-grace' },
    body: JSON.stringify({ email: 'grace@example.com', name: 'Grace Hopper' }),
  });

  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), firstBody);

  const conflict = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': 'create-grace' },
    body: JSON.stringify({ email: 'different@example.com', name: 'Different' }),
  });

  assert.equal(conflict.status, 409);
});

test('GET /v1/users lists users with cursor pagination', async () => {
  const a = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'list-a@example.com', name: 'List A' }),
  });
  const b = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'list-b@example.com', name: 'List B' }),
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const first = await app.request('/v1/users?limit=1');
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { data: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(firstBody.data.length, 1);
  assert.equal(typeof firstBody.nextCursor, 'string');

  const second = await app.request(`/v1/users?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`);
  assert.equal(second.status, 200);
  const secondBody = await second.json() as { data: Array<{ id: string }>; nextCursor: string | null };
  assert.equal(secondBody.data.length, 1);
  assert.notEqual(secondBody.data[0]?.id, firstBody.data[0]?.id);
});

test('GET, PATCH and DELETE /v1/users/:id operate on a user', async () => {
  const created = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'crud@example.com', name: 'Crud User' }),
  });
  const user = await created.json() as { id: string };

  const fetched = await app.request(`/v1/users/${user.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json() as { id: string }).id, user.id);

  const patched = await app.request(`/v1/users/${user.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Updated User', role: 'admin' }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json() as { name: string; role: string };
  assert.equal(patchedBody.name, 'Updated User');
  assert.equal(patchedBody.role, 'admin');

  const deleted = await app.request(`/v1/users/${user.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), '');

  const missing = await app.request(`/v1/users/${user.id}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-type'), 'application/problem+json');
});

test('invalid input returns 422 application/problem+json', async () => {
  const invalidCreate = await app.request('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', name: '' }),
  });
  assert.equal(invalidCreate.status, 422);
  assert.equal(invalidCreate.headers.get('content-type'), 'application/problem+json');

  const invalidList = await app.request('/v1/users?limit=101');
  assert.equal(invalidList.status, 422);
  assert.equal(invalidList.headers.get('content-type'), 'application/problem+json');

  const invalidPatch = await app.request('/v1/users/not-a-uuid', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'owner' }),
  });
  assert.equal(invalidPatch.status, 422);
  assert.equal(invalidPatch.headers.get('content-type'), 'application/problem+json');
});

test('missing users return 404 problems', async () => {
  const missingId = '00000000-0000-4000-8000-000000000000';

  for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
    const res = await app.request(`/v1/users/${missingId}`, {
      method,
      headers: method === 'PATCH' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'PATCH' ? JSON.stringify({ name: 'Nobody' }) : undefined,
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type'), 'application/problem+json');
    assert.equal(ProblemSchema.parse(await res.json()).status, 404);
  }
});
