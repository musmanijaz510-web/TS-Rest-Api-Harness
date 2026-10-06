// Model agnosticism, enforced: provider names may appear only inside harness/drivers/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../harness/core/registry.ts';
import { loadTask } from '../harness/core/task.ts';
import { cleanup, scratch, writeTask } from './helpers.ts';

const PROVIDER = /anthropic|openai|claude|\bgpt[-\d]|gemini/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('no provider names in tasks, hooks, rules, tools, templates or core', () => {
  const dirs = ['tasks', 'plugins', 'harness/core', 'harness/templates'].map((d) => join(REPO_ROOT, d));
  const leaks = dirs.flatMap(files).filter((f) => PROVIDER.test(readFileSync(f, 'utf8')));
  assert.deepEqual(leaks, []);
});

test('a task file may not choose its model', () => {
  const dir = scratch('task');
  try {
    assert.throws(() => loadTask(writeTask(dir, { id: 'x', description: 'd', model: 'anything' })), /must not set model/);
    assert.throws(() => loadTask(writeTask(dir, { id: 'x', description: 'd', provider: 'anything' })), /must not set provider/);
  } finally {
    cleanup(dir);
  }
});

test('lenient task loading: defaults id, kind and target', () => {
  const dir = scratch('task2');
  try {
    const t = loadTask(writeTask(dir, { description: 'A todos API', resource: { name: 'todos', fields: [] } }));
    assert.equal(t.kind, 'greenfield');
    assert.equal(t.target, 'generated/task');
  } finally {
    cleanup(dir);
  }
});
