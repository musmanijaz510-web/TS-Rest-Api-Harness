// End-to-end: the real loop, hooks, tools, gates and ship step, driven by a
// scripted (provider-free) driver against a copy of the known-good fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTask } from '../harness/core/loop.ts';
import { REPO_ROOT } from '../harness/core/registry.ts';
import { ship } from '../harness/core/ship.ts';
import { call, cleanup, copyFixture, scratch, scriptedDriver, writeTask } from './helpers.ts';

const PATCH_TEST = `
test('PATCH /v1/notes/:id updates, 404s and 422s', async () => {
  const note = NoteSchema.parse(await (await create({ title: 'old' })).json());
  const patch = (id: string, body: unknown) =>
    app.request(\`/v1/notes/\${id}\`, { method: 'PATCH', headers: json, body: JSON.stringify(body) });
  const res = await patch(note.id, { title: 'new' });
  assert.equal(res.status, 200);
  assert.equal(NoteSchema.parse(await res.json()).title, 'new');
  assert.equal((await patch(note.id, {})).status, 422);
  assert.equal((await patch('7d0c7a52-8a43-4e4c-9a4f-0b1f2f7e1c11', { title: 'x' })).status, 404);
});
`;

const UPDATE_SCHEMA = `
export const UpdateNoteSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().max(10_000).optional() })
  .refine((v) => v.title !== undefined || v.body !== undefined, { message: 'provide title or body' });
`;

const PATCH_ROUTE = `  app.patch('/v1/notes/:id', async (c) => {
    const { id } = await parseRequest(NoteParamsSchema, c.req.param());
    const changes = await parseRequest(UpdateNoteSchema, c.req.json());
    const note = findNote(id);
    if (!note) return problem(c, 404, \`Note \${id} not found\`);
    return c.json(NoteSchema.parse(saveNote({ ...note, ...changes })));
  });

  app.delete('/v1/notes/:id',`;

/** A well-behaved model: tries to cheat once, then does red -> green properly. */
function goodScript(ws: string) {
  const testFile = readFileSync(join(ws, 'test/notes.test.ts'), 'utf8');
  return [
    [call('list_files', { dir: '.' }), call('write_file', { path: 'src/notes/routes.ts', content: '// skip the test' })],
    [call('write_file', { path: 'test/notes.test.ts', content: testFile + PATCH_TEST })],
    [call('run_tests', { files: ['test/notes.test.ts'] })],
    [
      call('edit_file', { path: 'src/notes/schema.ts', old: "export const NoteParamsSchema", new: `${UPDATE_SCHEMA.trim()}\n\nexport const NoteParamsSchema` }),
      call('edit_file', {
        path: 'src/notes/routes.ts',
        old: "import { CreateNoteSchema, NotePageSchema, NoteParamsSchema, NoteSchema } from './schema.ts';",
        new: "import { CreateNoteSchema, NotePageSchema, NoteParamsSchema, NoteSchema, UpdateNoteSchema } from './schema.ts';",
      }),
      call('edit_file', { path: 'src/notes/routes.ts', old: "  app.delete('/v1/notes/:id',", new: PATCH_ROUTE }),
    ],
    [call('run_tests', {}), call('run_checks', {})],
    [],
  ];
}

const TASK = (target: string) => ({
  id: 'notes-patch-test',
  kind: 'brownfield',
  target,
  description: 'Add PATCH /v1/notes/:id',
  scope: ['src/notes/**', 'test/notes*.test.ts'],
});

function removeRunArtifacts(runId: string): void {
  rmSync(join(REPO_ROOT, 'runs', runId), { recursive: true, force: true });
  rmSync(join(REPO_ROOT, 'tokens', `${runId}.json`), { force: true });
}

test('a model that follows red -> green ends green; the cheat attempt is blocked', async () => {
  const dir = scratch('loop');
  try {
    const ws = copyFixture(join(dir, 'api'));
    const driver = scriptedDriver(goodScript(ws));
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver, maxTurns: 10 });
    try {
      assert.equal(s.status, 'green', JSON.stringify(s.gates, null, 2));
      assert.equal(s.blocked, 1);
      assert.deepEqual(s.red, ['test/notes.test.ts']);
      assert.ok(s.changed.includes('src/notes/routes.ts'));
      assert.equal(s.standardsPercent, 100);
      // The blocked write never reached disk.
      assert.doesNotMatch(readFileSync(join(ws, 'src/notes/routes.ts'), 'utf8'), /skip the test/);
      // Token report written by the harness, with a per-turn shadow baseline.
      const report = JSON.parse(readFileSync(join(REPO_ROOT, s.tokenReport), 'utf8'));
      assert.equal(report.turns.length, s.turns);
      assert.ok(report.totals.estimatedShadowBaseline > report.totals.estimatedInput);
      // JIT: the system prompt carries no file contents.
      assert.doesNotMatch(driver.requests[0]?.system ?? '', /registerNoteRoutes/);
      const events = readFileSync(join(REPO_ROOT, 'runs', s.runId, 'events.jsonl'), 'utf8');
      assert.match(events, /"hook":"observed-red","event":"pre","tool":"write_file","decision":"block"/);
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});

test('the model saying "done" is not enough: gates send it back, then the run ends red', async () => {
  const dir = scratch('lazy');
  try {
    const ws = copyFixture(join(dir, 'api'));
    const driver = scriptedDriver([[]]);
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver, maxTurns: 2 });
    try {
      assert.equal(s.status, 'red');
      assert.match(driver.requests[1]?.messages.at(-1)?.role === 'user' ? JSON.stringify(driver.requests[1]?.messages.at(-1)) : '', /Not finished/);
      assert.equal(s.gates.find((g) => g.gate === 'observed-red')?.status, 'UNPROVEN');
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});

test('baseline mode front-loads the workspace and keeps raw tool output', async () => {
  const dir = scratch('baseline');
  try {
    const ws = copyFixture(join(dir, 'api'));
    const driver = scriptedDriver([[call('run_tests', {})], []]);
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver, mode: 'baseline', maxTurns: 2 });
    try {
      assert.match(driver.requests[0]?.system ?? '', /registerNoteRoutes/);
      const toolMsg = driver.requests[1]?.messages.find((m) => m.role === 'tool');
      assert.match(JSON.stringify(toolMsg), /TAP version/);
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});

test('a reply cut off at the output limit is not treated as "done"', async () => {
  const dir = scratch('truncated');
  try {
    const ws = copyFixture(join(dir, 'api'));
    const driver = scriptedDriver(['truncated', []]);
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver, maxTurns: 2 });
    try {
      assert.match(JSON.stringify(driver.requests[1]?.messages.at(-1)), /cut off at the output-token limit/);
      const events = readFileSync(join(REPO_ROOT, 'runs', s.runId, 'events.jsonl'), 'utf8');
      assert.match(events, /"type":"truncated","turn":1/);
      assert.doesNotMatch(events, /"type":"gates","turn":1/);
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('ship: re-runs gates, commits to a feature branch via a temp index, pushes; never touches the working tree', async () => {
  const dir = scratch('ship');
  try {
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', remote);
    const repo = join(dir, 'repo');
    copyFixture(join(repo, 'api'));
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', remote);

    const ws = join(repo, 'api');
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver: scriptedDriver(goodScript(ws)), maxTurns: 10 });
    try {
      assert.equal(s.status, 'green');
      const statusBefore = git(repo, 'status', '--porcelain');
      const report = await ship({ runId: s.runId, pr: false });
      assert.equal(report.shipped, true, JSON.stringify(report.steps, null, 2));
      assert.ok(report.branch?.startsWith('harness/notes-patch-test-'));
      assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
      assert.equal(git(repo, 'status', '--porcelain'), statusBefore);
      assert.match(git(remote, 'log', '--format=%s', report.branch ?? ''), /harness: notes-patch-test/);
      assert.match(git(remote, 'show', `${report.branch}:api/src/notes/routes.ts`), /app\.patch/);
      assert.equal(report.steps.find((x) => x.step === 'pull-request')?.status, 'skipped');

      // Break a standard after the run: ship must refuse (no commit on red).
      writeFileSync(join(ws, 'src/notes/store.ts'), `${readFileSync(join(ws, 'src/notes/store.ts'), 'utf8')}\nexport const bad: any = 1;\n`);
      const refused = await ship({ runId: s.runId, pr: false });
      assert.equal(refused.shipped, false);
      assert.equal(refused.steps[0]?.status, 'refused');
      assert.match(refused.steps[0]?.detail ?? '', /no commit on red/);
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});

test('ship refuses an unknown run', async () => {
  const r = await ship({ runId: 'does-not-exist', pr: false });
  assert.equal(r.shipped, false);
  assert.equal(existsSync(join(REPO_ROOT, 'runs', 'does-not-exist')), false);
});

test('a test that cannot load reports the real error, and its raw log is readable via read_artifact', async () => {
  const dir = scratch('artifact');
  try {
    const ws = copyFixture(join(dir, 'api'));
    const bad = "import { createApp } from '../src/app.ts';\nimport { test } from 'node:test';\ntest('x', () => { createApp(); });\n";
    const driver = scriptedDriver([[call('write_file', { path: 'test/notes-extra.test.ts', content: bad })], [call('run_tests', { files: ['test/notes-extra.test.ts'] })], [call('read_artifact', { name: '001-tests.tap' })]]);
    const s = await runTask({ taskFile: writeTask(dir, TASK(ws)), driver, maxTurns: 4 });
    try {
      const testResult = JSON.stringify(driver.requests[2]?.messages.at(-1));
      assert.match(testResult, /does not provide an export named 'createApp'/);
      assert.match(testResult, /read_artifact/);
      const artifact = JSON.stringify(driver.requests[3]?.messages.at(-1));
      assert.match(artifact, /TAP version/);
    } finally {
      removeRunArtifacts(s.runId);
    }
  } finally {
    cleanup(dir);
  }
});
