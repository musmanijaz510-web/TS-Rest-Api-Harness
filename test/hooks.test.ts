import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadApi } from '../harness/core/api-model.ts';
import { surfaceOf } from '../harness/core/contract.ts';
import { RedLedger } from '../harness/core/ledger.ts';
import { loadRegistry } from '../harness/core/registry.ts';
import type { Hook, RunContext } from '../harness/core/types.ts';
import { FIXTURE } from './helpers.ts';
import { readFileSync } from 'node:fs';

const registry = await loadRegistry();
const hook = (name: string): Hook => {
  const h = registry.hooks.find((x) => x.name === name);
  if (!h) throw new Error(`hook ${name} not registered`);
  return h;
};

function ctx(scope = ['src/**', 'test/**']): RunContext {
  return {
    workspace: FIXTURE,
    runDir: join(FIXTURE, '.none'),
    task: { id: 't', kind: 'brownfield', target: FIXTURE, description: 'd', behaviours: [], scope, source: '' },
    mode: 'jit',
    ledger: new RedLedger(),
    contract: surfaceOf(loadApi(FIXTURE)),
    scope,
    rules: [],
    artifact: () => '',
  };
}

test('path-guard blocks escapes, protected files and out-of-scope writes', async () => {
  const g = hook('path-guard');
  const c = ctx(['src/notes/**']);
  for (const path of ['../evil.ts', 'package.json', 'tsconfig.json', 'node_modules/x/index.ts', 'src/app.ts']) {
    const d = await g.run({ tool: 'write_file', args: { path, content: '' } }, c);
    assert.equal(d.action, 'block', path);
  }
  assert.equal((await g.run({ tool: 'write_file', args: { path: 'src/notes/x.ts', content: '' } }, c)).action, 'pass');
});

test('observed-red blocks a source edit until a mapped test was seen failing', async () => {
  const g = hook('observed-red');
  const c = ctx();
  const ev = { tool: 'edit_file', args: { path: 'src/notes/routes.ts', old: 'a', new: 'b' } };
  const before = await g.run(ev, c);
  assert.equal(before.action, 'block');
  assert.match(before.action === 'block' ? before.feedback : '', /test\/notes\.test\.ts/);
  c.ledger.record('test/notes.test.ts', true); // green does not unlock
  assert.equal((await g.run(ev, c)).action, 'block');
  c.ledger.record('test/notes.test.ts', false); // observed red unlocks
  assert.equal((await g.run(ev, c)).action, 'pass');
});

test('observed-red never gates test files', async () => {
  const d = await hook('observed-red').run({ tool: 'write_file', args: { path: 'test/new.test.ts', content: '' } }, ctx());
  assert.equal(d.action, 'pass');
});

test('contract-lock refuses a write that removes an existing route, allows additions', async () => {
  const g = hook('contract-lock');
  const routes = readFileSync(join(FIXTURE, 'src/notes/routes.ts'), 'utf8');
  const removed = routes.replace(/  app\.delete\([\s\S]*?\n  \}\);\n/, '');
  const d = await g.run({ tool: 'write_file', args: { path: 'src/notes/routes.ts', content: removed } }, ctx());
  assert.equal(d.action, 'block');
  assert.match(d.action === 'block' ? d.feedback : '', /route removed: DELETE \/v1\/notes\/:id/);

  const schema = readFileSync(join(FIXTURE, 'src/notes/schema.ts'), 'utf8');
  const lostField = await g.run({ tool: 'edit_file', args: { path: 'src/notes/schema.ts', old: '  body: z.string().max(10_000),\n  createdAt', new: '  createdAt' } }, ctx());
  assert.equal(lostField.action, 'block', schema);

  const added = routes.replace('export function registerNoteRoutes(app: Hono): void {', "export function registerNoteRoutes(app: Hono): void {\n  app.get('/v1/tags', async (c) => c.json(TagsSchema.parse([])));");
  assert.equal((await g.run({ tool: 'write_file', args: { path: 'src/notes/routes.ts', content: added } }, ctx())).action, 'pass');
});
