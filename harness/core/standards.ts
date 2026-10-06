// Runs every registered Rule against an API and renders the report:
// one line per rule per file, then one summary line per rule, then a verdict.
import type { ApiModel } from './api-model.ts';
import type { Rule, Finding } from './types.ts';

export type FileStatus = 'pass' | 'fail' | 'n/a';
export type RuleSummary = {
  id: string;
  status: 'pass' | 'fail' | 'n/a' | 'UNPROVEN';
  passed: number;
  total: number;
  unit: string;
  note?: string;
  perFile: { file: string; status: FileStatus; passed: number; total: number; failures: Finding[] }[];
};
export type StandardsReport = {
  rules: RuleSummary[];
  /** 100 only when every mandatory rule passed and none is UNPROVEN. */
  percent: number;
  verdict: 'pass' | 'fail' | 'UNPROVEN';
};

export async function runStandards(api: ApiModel, rules: readonly Rule[]): Promise<StandardsReport> {
  const out: RuleSummary[] = [];
  for (const rule of rules) {
    let res;
    try {
      res = await rule.check(api);
    } catch (err) {
      res = { unit: 'checks', findings: [], unproven: `rule crashed: ${(err as Error).message}` };
    }
    const perFile = api.files.map((f) => {
      const fs = res.findings.filter((x) => x.file === f.path);
      const failures = fs.filter((x) => !x.ok);
      const status: FileStatus = fs.length === 0 ? 'n/a' : failures.length ? 'fail' : 'pass';
      return { file: f.path, status, passed: fs.length - failures.length, total: fs.length, failures };
    });
    // Findings on files outside the model (e.g. "no onError anywhere") still count.
    const orphan = res.findings.filter((x) => !api.files.some((f) => f.path === x.file));
    if (orphan.length) {
      const failures = orphan.filter((x) => !x.ok);
      perFile.push({
        file: '(api)',
        status: failures.length ? 'fail' : 'pass',
        passed: orphan.length - failures.length,
        total: orphan.length,
        failures,
      });
    }
    const total = res.findings.length;
    const passed = res.findings.filter((x) => x.ok).length;
    let status: RuleSummary['status'];
    let note: string | undefined;
    if (res.unproven) {
      status = 'UNPROVEN';
      note = res.unproven;
    } else if (total === 0) {
      status = rule.optional ? 'n/a' : 'UNPROVEN';
      note = rule.optional ? 'nothing to check' : `found no ${res.unit} to check`;
    } else status = passed === total ? 'pass' : 'fail';
    out.push({ id: rule.id, status, passed, total, unit: res.unit, perFile, ...(note ? { note } : {}) });
  }

  const counted = out.filter((r) => r.status !== 'n/a');
  const totalSubjects = counted.reduce((a, r) => a + r.total, 0);
  const passedSubjects = counted.reduce((a, r) => a + r.passed, 0);
  const anyFail = counted.some((r) => r.status === 'fail');
  const anyUnproven = counted.some((r) => r.status === 'UNPROVEN');
  const percent = totalSubjects === 0 ? 0 : Math.floor((passedSubjects / totalSubjects) * 100);
  return {
    rules: out,
    percent: anyFail ? Math.min(percent, 99) : anyUnproven ? percent : 100,
    verdict: anyFail ? 'fail' : anyUnproven ? 'UNPROVEN' : 'pass',
  };
}

const pad = (s: string, n: number): string => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));

/** Full report: per-file lines, then the summary block. */
export function formatStandards(report: StandardsReport, opts: { perFile?: boolean } = {}): string {
  const lines: string[] = [];
  const w = Math.max(18, ...report.rules.map((r) => r.id.length + 2));
  if (opts.perFile !== false) {
    for (const r of report.rules) {
      for (const f of r.perFile) {
        if (f.status === 'fail') {
          for (const x of f.failures) {
            lines.push(`${pad(r.id, w)}${pad('fail', 6)}${x.file}${x.line ? `:${x.line}` : ''}  ${x.message ?? ''}`.trimEnd());
          }
        } else {
          lines.push(`${pad(r.id, w)}${pad(f.status, 6)}${f.file}${f.total ? `  ${f.passed}/${f.total}` : ''}`);
        }
      }
    }
    lines.push('');
  }
  lines.push(...summaryLines(report, w));
  return lines.join('\n');
}

export function summaryLines(report: StandardsReport, w = 18): string[] {
  const lines = report.rules.map((r) => {
    const detail = r.status === 'UNPROVEN' || r.status === 'n/a' ? (r.note ?? '') : `${r.passed}/${r.total} ${r.unit}`;
    return `${pad(r.id, w)}${pad(r.status, 9)}${detail}`;
  });
  const unproven = report.rules.filter((r) => r.status === 'UNPROVEN').map((r) => r.id);
  if (report.verdict === 'UNPROVEN') lines.push(`${pad('verdict', w)}${pad('UNPROVEN', 9)}-> not green: ${unproven.join(', ')} could not be proven`);
  else lines.push(`${pad('verdict', w)}${pad(`${report.percent}%`, 9)}${report.verdict === 'pass' ? '-> all standards green' : '-> fail'}`);
  return lines;
}

/** Only failing/unproven lines: what the model needs to act on, nothing more. */
export function formatFailures(report: StandardsReport, max = 25): string {
  const lines: string[] = [];
  for (const r of report.rules) {
    if (r.status === 'UNPROVEN') lines.push(`${r.id} UNPROVEN: ${r.note ?? ''}`);
    for (const f of r.perFile) for (const x of f.failures) lines.push(`${r.id} fail ${x.file}${x.line ? `:${x.line}` : ''} ${x.message ?? ''}`.trimEnd());
  }
  const extra = lines.length > max ? [`... ${lines.length - max} more (run_checks for the next batch after fixing these)`] : [];
  return [...lines.slice(0, max), ...extra, `verdict ${report.percent}% ${report.verdict}`].join('\n');
}
