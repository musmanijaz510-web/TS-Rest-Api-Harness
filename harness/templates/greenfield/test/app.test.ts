import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.ts';
import { ProblemSchema } from '../src/lib/problem.ts';

test('unknown routes return an RFC 7807 problem', async () => {
  const res = await app.request('/v1/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const body = ProblemSchema.parse(await res.json());
  assert.equal(body.status, 404);
  assert.equal(body.instance, '/v1/does-not-exist');
});
