// Token report, written by the harness on every run. Two baselines, labelled
// honestly:
//  - shadow:   every turn, the harness also builds the request a non-JIT harness
//              would have sent at that point (full front-load, no compaction, raw
//              tool output) and estimates both with the same estimator.
//  - measured: `harness bench` runs the same task twice on the same driver
//              (--mode baseline, then --mode jit) and records provider-reported usage.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type TurnTokens = {
  turn: number;
  /** Provider-reported input tokens for the request actually sent. */
  inputTokens: number;
  outputTokens: number;
  /** Estimator (chars/4) applied to the request actually sent. */
  estimatedInput: number;
  /** Estimator applied to the counterfactual non-JIT request for the same turn. */
  estimatedShadowBaseline: number;
};

export type RunTokenReport = {
  runId: string;
  task: string;
  driver: string;
  mode: 'jit' | 'baseline';
  turns: TurnTokens[];
  totals: { inputTokens: number; outputTokens: number; estimatedInput: number; estimatedShadowBaseline: number };
  /** 1 - actual/baseline on the shadow estimate (same estimator both sides). */
  shadowReductionPct: number | null;
  peakInputTokens: number;
};

const pct = (actual: number, baseline: number): number | null =>
  baseline > 0 ? Math.round((1 - actual / baseline) * 1000) / 10 : null;

export function buildRunReport(meta: { runId: string; task: string; driver: string; mode: 'jit' | 'baseline' }, turns: TurnTokens[]): RunTokenReport {
  const sum = (k: keyof TurnTokens): number => turns.reduce((a, t) => a + t[k], 0);
  const totals = {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    estimatedInput: sum('estimatedInput'),
    estimatedShadowBaseline: sum('estimatedShadowBaseline'),
  };
  return {
    ...meta,
    turns,
    totals,
    shadowReductionPct: meta.mode === 'jit' ? pct(totals.estimatedInput, totals.estimatedShadowBaseline) : null,
    peakInputTokens: Math.max(0, ...turns.map((t) => t.inputTokens)),
  };
}

export type BenchReport = {
  task: string;
  driver: string;
  baselineRun: string;
  actualRun: string;
  /** Provider-reported input tokens per turn, both runs. */
  perTurn: { turn: number; baseline: number | null; actual: number | null }[];
  totals: { baseline: number; actual: number };
  /** The headline: 1 - actual/baseline on measured provider input tokens. */
  reductionPct: number | null;
  peak: { baseline: number; actual: number; reductionPct: number | null };
  bothRunsGreen: { baseline: boolean; actual: boolean };
};

export function buildBenchReport(base: RunTokenReport, actual: RunTokenReport, green: { baseline: boolean; actual: boolean }): BenchReport {
  const n = Math.max(base.turns.length, actual.turns.length);
  const perTurn = Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    baseline: base.turns[i]?.inputTokens ?? null,
    actual: actual.turns[i]?.inputTokens ?? null,
  }));
  return {
    task: actual.task,
    driver: actual.driver,
    baselineRun: base.runId,
    actualRun: actual.runId,
    perTurn,
    totals: { baseline: base.totals.inputTokens, actual: actual.totals.inputTokens },
    reductionPct: pct(actual.totals.inputTokens, base.totals.inputTokens),
    peak: {
      baseline: base.peakInputTokens,
      actual: actual.peakInputTokens,
      reductionPct: pct(actual.peakInputTokens, base.peakInputTokens),
    },
    bothRunsGreen: green,
  };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
