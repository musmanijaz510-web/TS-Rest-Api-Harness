// The harness's own test runner. Runs each test file in its own `node --test`
// subprocess so pass/fail is attributable per file, keeps the raw TAP on disk,
// and hands back one compact line per file.
import { spawnSync } from 'node:child_process';
import { listTsFiles } from './api-model.ts';

export type FileResult = { file: string; ok: boolean; passed: number; failed: number; summary: string };
export type TestRun = { results: FileResult[]; raw: string };

const TIMEOUT_MS = 120_000;
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Child env without credentials: model-written tests must never see provider keys. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k)) env[k] = v;
  delete env.NODE_TEST_CONTEXT; // otherwise a nested `node --test` reports to the parent runner
  delete env.NODE_OPTIONS;
  return env;
}

export function allTestFiles(workspace: string): string[] {
  return listTsFiles(workspace).filter((p) => p.endsWith('.test.ts'));
}

export function runTests(workspace: string, files?: readonly string[]): TestRun {
  const targets = (files && files.length ? [...files] : allTestFiles(workspace)).map((f) => f.replace(/^\.\//, ''));
  const results: FileResult[] = [];
  const raw: string[] = [];
  for (const file of targets) {
    const proc = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `./${file}`], {
      cwd: workspace,
      env: sanitizedEnv(),
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
    raw.push(`===== ${file} (exit ${proc.status ?? 'timeout'}) =====\n${out}`);
    const passed = count(out, /^# pass (\d+)/m);
    const failed = count(out, /^# fail (\d+)/m);
    const ok = proc.status === 0 && failed === 0 && passed > 0;
    let summary: string;
    if (proc.error) summary = `runner error: ${proc.error.message}`;
    else if (ok) summary = `${passed} passed`;
    else if (passed === 0 && failed === 0) summary = `no tests ran (exit ${proc.status ?? 'timeout'}): ${firstLines(out, 4)}`;
    else summary = `${failed} failed, ${passed} passed: ${firstFailure(out)}`;
    results.push({ file, ok, passed, failed, summary });
  }
  return { results, raw: raw.join('\n') };
}

function count(out: string, re: RegExp): number {
  const m = re.exec(out);
  return m?.[1] ? Number(m[1]) : 0;
}

function firstLines(out: string, n: number): string {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('TAP version'))
    .slice(0, n)
    .join(' | ')
    .slice(0, 400);
}

/** The first failing test's name plus its error/expected/actual lines. */
function firstFailure(out: string): string {
  const lines = out.split('\n');
  // Prefer the innermost (indented) failure, which carries the assertion detail.
  const idx = lines.findIndex((l) => /^\s+not ok /.test(l));
  const start = idx >= 0 ? idx : lines.findIndex((l) => /^not ok /.test(l));
  // Load-time failures (bad import, syntax) surface only as "# SomeError: ..." diagnostics.
  const loadErrors = lines
    .map((l) => l.trim())
    .filter((l) => /^#\s*[A-Za-z]*Error\b/.test(l) || /^#\s*(Cannot find|ERR_MODULE)/.test(l))
    .slice(0, 2)
    .map((l) => l.replace(/^#\s*/, ''));
  if (start < 0) return [...loadErrors, firstLines(out, 4)].join(' | ').slice(0, 600);
  const name = (lines[start] ?? '').trim();
  const detail = lines
    .slice(start + 1, start + 40)
    .map((l) => l.trim())
    .filter((l) => /^(error|expected|actual|location|code|operator):/.test(l) || /^at .*\.test\.ts/.test(l))
    .slice(0, 6);
  return [name, ...loadErrors, ...detail].join(' | ').slice(0, 600);
}
