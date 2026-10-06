// Standard 03 (compiler): tsc passes with strict and noUncheckedIndexedAccess forced
// on the command line, whatever the project's tsconfig says.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep, isAbsolute } from 'node:path';
import { defineRule, type Finding } from '#harness/plugin-api.ts';

const require = createRequire(import.meta.url);

function tscPath(): string | null {
  try {
    return require.resolve('typescript/bin/tsc');
  } catch {
    return null;
  }
}

export default defineRule({
  id: 'tsc-strict',
  description: 'tsc --noEmit passes with --strict --noUncheckedIndexedAccess.',
  hint: 'Fix every compiler error reported with file:line. Indexed access yields T | undefined: check it, do not assert it. Relative imports use the .ts extension; type-only imports use `import type`.',
  check(api) {
    const tsc = tscPath();
    if (!tsc) return { unit: 'files', findings: [], unproven: 'typescript is not installed; tsc could not run' };
    const config = join(api.root, 'tsconfig.json');
    const files = api.files.map((f) => f.path);
    const args = existsSync(config)
      ? ['-p', config]
      : ['--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2023', '--allowImportingTsExtensions', '--types', 'node', ...files];
    const proc = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '--strict', '--noUncheckedIndexedAccess', ...args], {
      cwd: api.root,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (proc.error) return { unit: 'files', findings: [], unproven: `tsc did not run: ${proc.error.message}` };
    const out = `${proc.stdout}${proc.stderr}`;
    const errors = new Map<string, { line: number; message: string }[]>();
    const loose: string[] = [];
    for (const line of out.split('\n')) {
      const m = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(line.trim());
      if (!m) {
        if (/error TS\d+/.test(line)) loose.push(line.trim());
        continue;
      }
      const [, file = '', ln = '0', message = ''] = m;
      const rel = (isAbsolute(file) ? relative(api.root, file) : file).split(sep).join('/');
      const list = errors.get(rel) ?? [];
      list.push({ line: Number(ln), message });
      errors.set(rel, list);
    }
    const findings: Finding[] = api.files.map((f) => {
      const errs = errors.get(f.path);
      const first = errs?.[0];
      return first ? { file: f.path, line: first.line, ok: false, message: `${errs.length} error(s); first: ${first.message}` } : { file: f.path, ok: true };
    });
    for (const [file, errs] of errors) {
      if (!api.files.some((f) => f.path === file)) findings.push({ file: '(api)', ok: false, message: `${file}:${errs[0]?.line ?? 0} ${errs[0]?.message ?? ''}` });
    }
    for (const l of loose) findings.push({ file: '(api)', ok: false, message: l });
    if (proc.status !== 0 && findings.every((f) => f.ok)) findings.push({ file: '(api)', ok: false, message: `tsc exited ${proc.status}: ${out.trim().slice(0, 300)}` });
    return { unit: 'files', findings };
  },
});
