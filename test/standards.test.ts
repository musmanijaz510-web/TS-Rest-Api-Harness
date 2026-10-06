import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApi } from '../harness/core/api-model.ts';
import { loadRegistry } from '../harness/core/registry.ts';
import { formatStandards, runStandards } from '../harness/core/standards.ts';
import { FIXTURE, cleanup, copyFixture, scratch } from './helpers.ts';

const registry = await loadRegistry();
const ROUTES = 'src/notes/routes.ts';
const routes = readFileSync(join(FIXTURE, ROUTES), 'utf8');

async function checkWith(file: string, text: string) {
  const all = await runStandards(loadApi(FIXTURE, new Map([[file, text]])), registry.rules.filter((r) => r.id !== 'tsc-strict'));
  return all;
}
const failures = (report: Awaited<ReturnType<typeof checkWith>>, rule: string) =>
  report.rules.find((r) => r.id === rule)?.perFile.flatMap((f) => f.failures) ?? [];

test('the known-good fixture is 100% on every rule, including tsc', async () => {
  const report = await runStandards(loadApi(FIXTURE), registry.rules);
  assert.equal(report.verdict, 'pass', formatStandards(report));
  assert.equal(report.percent, 100);
});

test('report prints one line per rule per file plus a verdict', async () => {
  const report = await runStandards(loadApi(FIXTURE), registry.rules.filter((r) => r.id !== 'tsc-strict'));
  const out = formatStandards(report);
  const files = loadApi(FIXTURE).files.length;
  for (const r of report.rules) assert.equal(out.split('\n').filter((l) => l.startsWith(`${r.id} `)).length, files + 1);
  assert.match(out, /^verdict\s+100%/m);
});

test('problem-json fails ad-hoc error bodies with file:line', async () => {
  const bad = routes.replace("return problem(c, 404, `Note ${id} not found`);\n    return c.json", "return c.json({ error: 'nope' }, 404);\n    return c.json");
  const r = await checkWith(ROUTES, bad);
  const f = failures(r, 'problem-json');
  assert.ok(f.some((x) => x.file === ROUTES && /non-2xx|error/.test(x.message ?? '')), JSON.stringify(f));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.percent < 100);
});

test('problem-json fails when app.onError is missing', async () => {
  const app = readFileSync(join(FIXTURE, 'src/app.ts'), 'utf8').replace(/app\.onError[\s\S]*?\n\}\);\n/, '');
  const f = failures(await checkWith('src/app.ts', app), 'problem-json');
  assert.ok(f.some((x) => /onError/.test(x.message ?? '')));
});

test('zod-boundary fails unparsed request input and unparsed responses', async () => {
  const bad = routes
    .replace('const input = await parseRequest(CreateNoteSchema, c.req.json());', 'const input = CreateNoteSchema.parse(await c.req.json());')
    .replace('return c.json(NoteSchema.parse(note));', 'return c.json(note);');
  const f = failures(await checkWith(ROUTES, bad), 'zod-boundary');
  assert.equal(f.length, 2);
  assert.match(f.map((x) => x.message).join(' '), /c\.req\.json\(\) is not passed straight/);
  assert.match(f.map((x) => x.message).join(' '), /c\.json\(\) body is not Schema\.parse/);
});

test('zod-infer fails hand-written object types', async () => {
  const file = 'src/notes/schema.ts';
  const text = `${readFileSync(join(FIXTURE, file), 'utf8')}\nexport interface NoteDto { id: string }\nexport type Other = { a: string };\n`;
  const f = failures(await checkWith(file, text), 'zod-infer');
  assert.match(f[0]?.message ?? '', /interface NoteDto.*type Other/);
});

test('type-escapes fails any, non-null assertions and ts directives', async () => {
  const file = 'src/notes/store.ts';
  const text = `${readFileSync(join(FIXTURE, file), 'utf8')}\nexport const x = (y: any) => y!;\n// @ts-ignore\n`;
  const f = failures(await checkWith(file, text), 'type-escapes');
  assert.match(f[0]?.message ?? '', /any.*non-null.*@ts-ignore/);
});

test('rest-conventions fails unversioned, singular, wrong-status routes', async () => {
  const bad = routes
    .replace("app.get('/v1/notes',", "app.get('/notes',")
    .replace("app.get('/v1/notes/:id',", "app.get('/v1/note/:id',")
    .replace('return c.body(null, 204);', 'return c.json(NoteSchema.parse({}), 200);');
  const f = failures(await checkWith(ROUTES, bad), 'rest-conventions');
  const msg = f.map((x) => x.message).join('\n');
  assert.match(msg, /version segment/);
  assert.match(msg, /"note" must be a plural/);
  assert.match(msg, /DELETE must respond c\.body\(null, 204\)/);
});

test('rest-conventions requires Idempotency-Key handling on POST', async () => {
  const bad = routes.replace('const key = await idempotencyKey(c);', 'const key = undefined;');
  const f = failures(await checkWith(ROUTES, bad), 'rest-conventions');
  assert.match(f.map((x) => x.message).join(' '), /Idempotency-Key/);
});

test('tsc-strict reports compiler errors with file:line', async () => {
  const dir = scratch('tsc');
  try {
    const ws = copyFixture(join(dir, 'api'));
    writeFileSync(join(ws, 'src/notes/store.ts'), `${readFileSync(join(ws, 'src/notes/store.ts'), 'utf8')}\nexport const first = (xs: string[]): string => xs[0];\n`);
    const tsc = registry.rules.filter((r) => r.id === 'tsc-strict');
    const report = await runStandards(loadApi(ws), tsc);
    const f = report.rules[0]?.perFile.flatMap((p) => p.failures) ?? [];
    assert.equal(report.verdict, 'fail');
    assert.equal(f[0]?.file, 'src/notes/store.ts');
    assert.ok((f[0]?.line ?? 0) > 1);
  } finally {
    cleanup(dir);
  }
});

test('an API with no routes is UNPROVEN, never green', async () => {
  const report = await runStandards(loadApi(FIXTURE, new Map([[ROUTES, 'export {};\n']])), registry.rules.filter((r) => r.id !== 'tsc-strict'));
  assert.equal(report.verdict, 'UNPROVEN');
  assert.match(formatStandards(report), /^verdict\s+UNPROVEN/m);
});
