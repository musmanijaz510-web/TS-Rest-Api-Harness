// harness <command> — the only entry point. Exit codes: 0 green, 1 red/fail, 2 UNPROVEN or usage error.
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadApi } from './api-model.ts';
import { mappedTests } from './ledger.ts';
import { runTask, type RunSummary } from './loop.ts';
import { DEFAULT_PLUGIN_ROOT, REPO_ROOT, driverNames, loadRegistry } from './registry.ts';
import { ship } from './ship.ts';
import { formatStandards, runStandards } from './standards.ts';
import { loadTask, taskTarget } from './task.ts';
import { buildBenchReport, readJson, writeJson, type RunTokenReport } from './tokens.ts';
import type { Mode } from './types.ts';

const USAGE = `usage:
  harness run   <task.json> --driver <name> [--mode jit|baseline] [--max-turns N] [--max-output-tokens N] [--ship] [--base <branch>]
  harness bench <task.json> --driver <name> [--max-turns N]     baseline run + JIT run -> tokens/bench-*.json
  harness check --api <dir> [--json]                             standards report for an API
  harness ship  --run <runId> [--base <branch>] [--remote origin] [--no-pr]
  harness map   --api <dir> <source.ts>                          tests mapped to a source file
  harness plugins                                                registered drivers, tools, hooks, rules`;

// Keys and overrides from <repo>/.env; variables already exported in the shell win.
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function printRun(s: RunSummary): void {
  console.log(`\nrun      ${s.runId}`);
  if (s.model) console.log(`model    ${s.model}`);
  console.log(`status   ${s.status.toUpperCase()}: ${s.reason}`);
  console.log(`turns    ${s.turns} (${s.toolCalls} tool calls, ${s.blocked} blocked by hooks)`);
  for (const g of s.gates) console.log(`gate     ${g.gate.padEnd(14)}${g.status.padEnd(10)}${g.detail}`);
  console.log(`tokens   ${s.tokenReport}`);
  console.log(`evidence runs/${s.runId}/ (events.jsonl, standards.txt, tests.log, ledger.json)`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      driver: { type: 'string' },
      mode: { type: 'string', default: 'jit' },
      'max-turns': { type: 'string', default: '40' },
      'max-output-tokens': { type: 'string', default: process.env.HARNESS_MAX_OUTPUT_TOKENS ?? '8192' },
      ship: { type: 'boolean', default: false },
      base: { type: 'string' },
      remote: { type: 'string', default: 'origin' },
      'no-pr': { type: 'boolean', default: false },
      api: { type: 'string' },
      run: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const maxTurns = Number(values['max-turns']);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('--max-turns must be a positive integer');
  const maxOutputTokens = Number(values['max-output-tokens']);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256) throw new Error('--max-output-tokens must be an integer >= 256');

  switch (cmd) {
    case 'run': {
      const taskFile = positionals[0];
      if (!taskFile || !values.driver) return usage();
      if (values.mode !== 'jit' && values.mode !== 'baseline') throw new Error('--mode must be jit or baseline');
      const summary = await runTask({ taskFile, driver: values.driver, mode: values.mode as Mode, maxTurns, maxOutputTokens });
      printRun(summary);
      if (summary.status !== 'green') return 1;
      if (values.ship) {
        const report = await ship({ runId: summary.runId, remote: values.remote, base: values.base, pr: !values['no-pr'] });
        for (const s of report.steps) console.log(`ship     ${s.step.padEnd(14)}${s.status.padEnd(10)}${s.detail.split('\n')[0]}`);
        return report.shipped ? 0 : 1;
      }
      return 0;
    }

    case 'bench': {
      const taskFile = positionals[0];
      if (!taskFile || !values.driver) return usage();
      const task = loadTask(taskFile);
      const target = taskTarget(task);
      // Baseline runs on a throwaway copy inside the repo (so dependencies resolve) and never touches the real target.
      const scratch = join(REPO_ROOT, 'runs', `_bench-${task.id}-${values.driver}-${Date.now()}`);
      mkdirSync(scratch, { recursive: true });
      const baseWs = join(scratch, 'workspace');
      if (task.kind === 'brownfield') {
        cpSync(target, baseWs, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes(`${'/'}.git`) });
        if (existsSync(join(target, 'node_modules'))) symlinkSync(join(target, 'node_modules'), join(baseWs, 'node_modules'));
      }
      console.log(`bench: baseline run (fetchers + compaction disabled) in ${baseWs}`);
      const base = await runTask({ taskFile, driver: values.driver, mode: 'baseline', maxTurns, maxOutputTokens, workspace: baseWs });
      printRun(base);
      console.log('\nbench: JIT run on the real target');
      const actual = await runTask({ taskFile, driver: values.driver, mode: 'jit', maxTurns, maxOutputTokens });
      printRun(actual);
      const report = buildBenchReport(
        readJson<RunTokenReport>(join(REPO_ROOT, base.tokenReport)),
        readJson<RunTokenReport>(join(REPO_ROOT, actual.tokenReport)),
        { baseline: base.status === 'green', actual: actual.status === 'green' },
      );
      const out = join(REPO_ROOT, 'tokens', `bench-${task.id}-${values.driver}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeJson(out, report);
      rmSync(scratch, { recursive: true, force: true });
      console.log(`\ntokens   baseline ${report.totals.baseline} -> actual ${report.totals.actual} input tokens: ${report.reductionPct ?? 'n/a'}% reduction`);
      console.log(`peak     baseline ${report.peak.baseline} -> actual ${report.peak.actual}: ${report.peak.reductionPct ?? 'n/a'}% reduction`);
      console.log(`report   ${out}`);
      return actual.status === 'green' ? 0 : 1;
    }

    case 'check': {
      if (!values.api) return usage();
      const root = resolve(values.api);
      if (!existsSync(root)) throw new Error(`no such directory: ${values.api}`);
      const registry = await loadRegistry();
      const report = await runStandards(loadApi(root), registry.rules);
      console.log(values.json ? JSON.stringify(report, null, 2) : formatStandards(report));
      return report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2;
    }

    case 'ship': {
      if (!values.run) return usage();
      const report = await ship({ runId: values.run, remote: values.remote, base: values.base, pr: !values['no-pr'] });
      for (const s of report.steps) console.log(`${s.step.padEnd(14)}${s.status.padEnd(10)}${s.detail}`);
      return report.shipped ? 0 : 1;
    }

    case 'map': {
      const source = positionals[0];
      if (!values.api || !source) return usage();
      const tests = mappedTests(loadApi(resolve(values.api)), source.replace(/^\.\//, ''));
      console.log(tests.length ? tests.join('\n') : `no tests map to ${source}`);
      return tests.length ? 0 : 1;
    }

    case 'plugins': {
      const reg = await loadRegistry();
      const origin = (key: string): string => (reg.origins.get(key) ?? '').replace(`${DEFAULT_PLUGIN_ROOT}/`, 'plugins/');
      console.log(`drivers  ${driverNames().join(', ')}`);
      for (const t of reg.tools.values()) console.log(`tool     ${t.name.padEnd(22)}${origin(`tool:${t.name}`)}`);
      for (const h of reg.hooks) console.log(`hook     ${`${h.name} (${h.event})`.padEnd(22)}${origin(`hook:${h.name}`)}`);
      for (const r of reg.rules) console.log(`rule     ${r.id.padEnd(22)}${origin(`rule:${r.id}`)}`);
      return 0;
    }

    default:
      return usage();
  }
}

function usage(): number {
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`harness: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
