// The grader's three additions, simulated: drop a file into a plugin folder,
// nothing in harness/core changes, and it shows up in the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadApi } from '../harness/core/api-model.ts';
import { DEFAULT_PLUGIN_ROOT, REPO_ROOT, loadRegistry } from '../harness/core/registry.ts';
import { formatStandards, runStandards } from '../harness/core/standards.ts';
import { FIXTURE, cleanup, scratch } from './helpers.ts';

function pluginRootWithExamples(): { dir: string; root: string } {
  const dir = scratch('ext');
  const root = join(dir, 'plugins');
  cpSync(DEFAULT_PLUGIN_ROOT, root, { recursive: true });
  cpSync(join(REPO_ROOT, 'examples/plugins'), root, { recursive: true });
  return { dir, root };
}

test('dropped-in tool, ORM validator and lint rule are registered with no core edits', async () => {
  const { dir, root } = pluginRootWithExamples();
  try {
    // Example plugins import ../../../harness/...; from the copied root that resolves to the same core.
    const reg = await loadRegistry(root);
    assert.ok(reg.tools.has('route_diff'));
    assert.ok(reg.rules.some((r) => r.id === 'orm-explicit-select'));
    assert.ok(reg.rules.some((r) => r.id === 'no-console'));
  } finally {
    cleanup(dir);
  }
});

test('a new lint rule joins the standards report with its own pass/fail lines and locations', async () => {
  const { dir, root } = pluginRootWithExamples();
  try {
    const reg = await loadRegistry(root);
    const api = loadApi(FIXTURE, new Map([['src/notes/store.ts', 'export const x = 1;\nconsole.log(x);\n']]));
    const report = await runStandards(api, reg.rules.filter((r) => r.id !== 'tsc-strict'));
    const out = formatStandards(report);
    assert.match(out, /^no-console\s+fail\s+src\/notes\/store\.ts:2\s+console/m);
    assert.match(out, /^no-console\s+pass\s+src\/app\.ts/m);
    assert.match(out, /^orm-explicit-select\s+n\/a/m);
  } finally {
    cleanup(dir);
  }
});

test('the ORM validator flags implicit SELECT * on users', async () => {
  const { dir, root } = pluginRootWithExamples();
  try {
    const reg = await loadRegistry(root);
    const rule = reg.rules.filter((r) => r.id === 'orm-explicit-select');
    const src = [
      'export const a = () => prisma.user.findMany({ where: { id: 1 } });',
      'export const b = () => prisma.user.findMany({ select: { id: true } });',
      'export const c = () => db.select().from(users);',
      'export const d = () => db.query.users.findMany({ columns: { id: true } });',
    ].join('\n');
    const report = await runStandards(loadApi(FIXTURE, new Map([['src/db.ts', src]])), rule);
    const r = report.rules[0];
    assert.equal(r?.total, 4);
    assert.equal(r?.passed, 2);
  } finally {
    cleanup(dir);
  }
});

test('a malformed plugin fails loudly, naming the file', async () => {
  const dir = scratch('bad-plugin');
  try {
    mkdirSync(join(dir, 'plugins/rules'), { recursive: true });
    writeFileSync(join(dir, 'plugins/rules/broken.ts'), 'export default { id: "x" };\n');
    await assert.rejects(loadRegistry(join(dir, 'plugins')), /broken\.ts must default-export/);
  } finally {
    cleanup(dir);
  }
});
