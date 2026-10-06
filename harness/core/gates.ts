// The final gates. The loop ends green only when these say so, and ship re-runs
// them from scratch rather than trusting the run's own summary.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApi, listTsFiles } from './api-model.ts';
import { breakingChanges, surfaceOf, type Surface } from './contract.ts';
import { isGatedSource, mappedTests } from './ledger.ts';
import { runStandards, type StandardsReport } from './standards.ts';
import { runTests, type TestRun } from './testrun.ts';
import type { Rule } from './types.ts';

export type GateStatus = 'pass' | 'fail' | 'UNPROVEN';
export type GateResult = { gate: string; status: GateStatus; detail: string; proves: string };
export type GateReport = { gates: GateResult[]; standards: StandardsReport; tests: TestRun; green: boolean };

/** Content hashes of every .ts file, to find what changed without trusting any tool. */
export function snapshot(workspace: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of listTsFiles(workspace)) out[p] = createHash('sha256').update(readFileSync(join(workspace, p))).digest('hex');
  return out;
}

export function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => before[k] !== after[k]).sort();
}

export async function runGates(input: {
  workspace: string;
  rules: readonly Rule[];
  contract: Surface;
  /** Sources the model changed this run, and the tests the harness saw red. */
  changed: readonly string[];
  red: ReadonlySet<string>;
}): Promise<GateReport> {
  const api = loadApi(input.workspace);
  const standards = await runStandards(api, input.rules);
  const tests = runTests(input.workspace);
  const gates: GateResult[] = [];

  gates.push({
    gate: 'standards',
    status: standards.verdict === 'pass' ? 'pass' : standards.verdict === 'fail' ? 'fail' : 'UNPROVEN',
    detail: `${standards.verdict === 'UNPROVEN' ? 'UNPROVEN' : `${standards.percent}%`} (${standards.rules.map((r) => `${r.id}:${r.status}`).join(', ')})`,
    proves: 'every registered standards rule passed on every file it applies to',
  });

  const failing = tests.results.filter((r) => !r.ok);
  gates.push({
    gate: 'tests',
    status: tests.results.length === 0 ? 'UNPROVEN' : failing.length ? 'fail' : 'pass',
    detail:
      tests.results.length === 0
        ? 'no test files found'
        : failing.length
          ? failing.map((f) => `${f.file}: ${f.summary}`).join('; ')
          : `${tests.results.length} file(s), ${tests.results.reduce((a, r) => a + r.passed, 0)} tests passed`,
    proves: 'every test file passed under the harness runner (not the model)',
  });

  const breaks = breakingChanges(input.contract, surfaceOf(api));
  gates.push({
    gate: 'contract',
    status: breaks.length ? 'fail' : 'pass',
    detail: breaks.length ? breaks.join('; ') : `${input.contract.routes.length} pre-existing route(s) and ${Object.keys(input.contract.schemas).length} schema(s) intact`,
    proves: 'no route or exported schema field that existed before the run was removed',
  });

  const sources = input.changed.filter(isGatedSource);
  const unred = sources.filter((s) => !mappedTests(api, s).some((t) => input.red.has(t)));
  gates.push({
    gate: 'observed-red',
    status: unred.length ? 'fail' : sources.length ? 'pass' : 'UNPROVEN',
    detail: unred.length
      ? `changed without a mapped test observed red: ${unred.join(', ')}`
      : sources.length
        ? `${sources.length} changed source file(s), each with a mapped test the harness saw fail`
        : 'no source files changed',
    proves: 'each changed source file has a mapped test that the harness runner saw fail before it was edited',
  });

  // observed-red UNPROVEN with zero changed sources is not a failure of the work, but it is not green either.
  const green = gates.every((g) => g.status === 'pass');
  return { gates, standards, tests, green };
}

export function formatGates(r: GateReport): string {
  return r.gates.map((g) => `${g.gate.padEnd(14)}${g.status.padEnd(10)}${g.detail}`).join('\n');
}
