// The harness ships; the model never does. Git runs here as a subprocess, only
// after the gates are re-run green, only to a fresh feature branch, never forced.
// The commit is built through a temporary index, so the user's working tree,
// index and current branch are never modified.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { formatGates, runGates } from './gates.ts';
import { loadRegistry, REPO_ROOT } from './registry.ts';
import { summaryLines } from './standards.ts';
import { readJson, writeJson } from './tokens.ts';
import type { Surface } from './contract.ts';
import type { RunSummary } from './loop.ts';

export const PROTECTED_BRANCH = /^(main|master|develop|development|trunk|production|prod|release(\/.*)?|hotfix\/.*)$/;

export type ShipStep = { step: string; status: 'done' | 'refused' | 'skipped' | 'failed'; detail: string };
export type ShipReport = { runId: string; branch: string | null; commit: string | null; prUrl: string | null; steps: ShipStep[]; shipped: boolean };

export type ShipOptions = {
  runId: string;
  remote?: string;
  base?: string;
  pr?: boolean;
  pluginRoot?: string;
  /** For tests: where runs/ lives. */
  repoRoot?: string;
};

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): { ok: boolean; out: string } {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { ok: p.status === 0, out: `${p.stdout ?? ''}${p.stderr ?? ''}`.trim() };
}

export async function ship(opts: ShipOptions): Promise<ShipReport> {
  const root = opts.repoRoot ?? REPO_ROOT;
  const runDir = join(root, 'runs', opts.runId);
  const steps: ShipStep[] = [];
  const report: ShipReport = { runId: opts.runId, branch: null, commit: null, prUrl: null, steps, shipped: false };
  const finish = (): ShipReport => {
    if (existsSync(runDir)) writeJson(join(runDir, 'ship.json'), report);
    return report;
  };

  if (!existsSync(join(runDir, 'summary.json'))) {
    steps.push({ step: 'load-run', status: 'refused', detail: `no run summary at ${runDir}` });
    return finish();
  }
  const summary = readJson<RunSummary>(join(runDir, 'summary.json'));
  const contract = readJson<Surface>(join(runDir, 'contract.json'));
  const ledger = readJson<{ red: string[] }>(join(runDir, 'ledger.json'));

  // 1. Re-run every gate. The run's own verdict is not trusted.
  const registry = await loadRegistry(opts.pluginRoot);
  const gates = await runGates({ workspace: summary.workspace, rules: registry.rules, contract, changed: summary.changed, red: new Set(ledger.red) });
  if (!gates.green) {
    steps.push({ step: 'gates', status: 'refused', detail: `no commit on red:\n${formatGates(gates)}` });
    return finish();
  }
  steps.push({ step: 'gates', status: 'done', detail: 'all gates re-run green' });

  // 2. Locate the repository.
  const top = git(summary.workspace, ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    steps.push({ step: 'repo', status: 'refused', detail: `workspace is not inside a git repository: ${summary.workspace}` });
    return finish();
  }
  const repo = top.out;
  const pathspec = relative(repo, summary.workspace) || '.';

  // 3. Feature branch only; never reuse or overwrite an existing branch.
  const branch = `harness/${summary.task}-${opts.runId.slice(-24).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase()}`;
  if (PROTECTED_BRANCH.test(branch)) {
    steps.push({ step: 'branch', status: 'refused', detail: `refusing protected branch ${branch}` });
    return finish();
  }
  if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    steps.push({ step: 'branch', status: 'refused', detail: `branch already exists: ${branch}` });
    return finish();
  }

  // 4. Commit through a temporary index: working tree, index and HEAD stay untouched.
  const index = join(runDir, 'ship.index');
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index, ...identityEnv(repo) };
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const parent = head.ok ? head.out : null;
  const read = parent ? git(repo, ['read-tree', parent], env) : git(repo, ['read-tree', '--empty'], env);
  const add = git(repo, ['add', '-A', '--', pathspec], env);
  const tree = git(repo, ['write-tree'], env);
  rmSync(index, { force: true });
  if (!read.ok || !add.ok || !tree.ok) {
    steps.push({ step: 'commit', status: 'failed', detail: [read.out, add.out, tree.out].filter(Boolean).join('\n') });
    return finish();
  }
  if (parent && git(repo, ['rev-parse', `${parent}^{tree}`]).out === tree.out) {
    steps.push({ step: 'commit', status: 'refused', detail: 'nothing to commit: the workspace matches HEAD' });
    return finish();
  }
  const message = [
    `harness: ${summary.task} (${summary.driver})`,
    '',
    `Run: ${opts.runId}`,
    'Gates (re-run before commit):',
    formatGates(gates),
    '',
    'Standards:',
    ...summaryLines(gates.standards),
  ].join('\n');
  const commit = git(repo, ['commit-tree', tree.out, ...(parent ? ['-p', parent] : []), '-m', message], identityEnv(repo));
  if (!commit.ok) {
    steps.push({ step: 'commit', status: 'failed', detail: commit.out });
    return finish();
  }
  // Empty old-value: the update fails if the branch appeared meanwhile.
  const ref = git(repo, ['update-ref', `refs/heads/${branch}`, commit.out, '']);
  if (!ref.ok) {
    steps.push({ step: 'commit', status: 'failed', detail: ref.out });
    return finish();
  }
  report.branch = branch;
  report.commit = commit.out;
  steps.push({ step: 'commit', status: 'done', detail: `${commit.out.slice(0, 12)} on ${branch} (working tree untouched)` });

  // 5. Push the feature branch. Never forced, never to a protected name.
  const remote = opts.remote ?? 'origin';
  if (!git(repo, ['remote', 'get-url', remote]).ok) {
    steps.push({ step: 'push', status: 'skipped', detail: `UNPROVEN: no remote "${remote}" configured` });
    return finish();
  }
  const push = git(repo, ['push', '--no-force', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
  if (!push.ok) {
    steps.push({ step: 'push', status: 'failed', detail: push.out });
    return finish();
  }
  steps.push({ step: 'push', status: 'done', detail: `${remote}/${branch}` });
  report.shipped = true;

  // 6. Pull request via gh, if available.
  if (opts.pr === false) {
    steps.push({ step: 'pull-request', status: 'skipped', detail: 'UNPROVEN: disabled with --no-pr' });
    return finish();
  }
  const body = [
    `Opened by the harness after all gates re-ran green. Run \`${opts.runId}\` (driver: ${summary.driver}).`,
    '',
    '```',
    formatGates(gates),
    '',
    ...summaryLines(gates.standards),
    '```',
    '',
    `Token report: \`${summary.tokenReport}\`. Evidence: \`runs/${opts.runId}/\`.`,
  ].join('\n');
  const pr = spawnSync(
    'gh',
    ['pr', 'create', '--head', branch, '--title', `harness: ${summary.task}`, '--body', body, ...(opts.base ? ['--base', opts.base] : [])],
    { cwd: repo, encoding: 'utf8' },
  );
  if (pr.error || pr.status !== 0) {
    steps.push({ step: 'pull-request', status: 'skipped', detail: `UNPROVEN: gh pr create failed: ${(pr.error?.message ?? pr.stderr ?? '').trim()}` });
    return finish();
  }
  report.prUrl = (pr.stdout ?? '').trim().split('\n').pop() ?? null;
  steps.push({ step: 'pull-request', status: 'done', detail: report.prUrl ?? '' });
  return finish();
}

/** Fall back to a harness identity only when the repo has none configured. */
function identityEnv(repo: string): NodeJS.ProcessEnv {
  const name = git(repo, ['config', 'user.name']);
  const email = git(repo, ['config', 'user.email']);
  if (name.ok && email.ok) return {};
  return {
    GIT_AUTHOR_NAME: 'ts-api-harness',
    GIT_AUTHOR_EMAIL: 'harness@localhost',
    GIT_COMMITTER_NAME: 'ts-api-harness',
    GIT_COMMITTER_EMAIL: 'harness@localhost',
  };
}

