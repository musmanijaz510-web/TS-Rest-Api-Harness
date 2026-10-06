// The harness loop: model -> hooks -> tools -> hooks, repeated, ending only when
// the deterministic gates are green (or the turn budget runs out).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApi } from './api-model.ts';
import { compactHistory, buildSystemPrompt, estimateTokens, toolSpecs } from './context.ts';
import { surfaceOf } from './contract.ts';
import { changedFiles, formatGates, runGates, snapshot, type GateReport } from './gates.ts';
import { RedLedger } from './ledger.ts';
import { REPO_ROOT, loadDriver, loadRegistry, type Registry } from './registry.ts';
import { scaffoldGreenfield } from './scaffold.ts';
import { formatFailures, formatStandards } from './standards.ts';
import { loadTask, taskTarget, type Task } from './task.ts';
import { buildRunReport, writeJson, type TurnTokens } from './tokens.ts';
import type { Driver, Message, Mode, RunContext, ToolCall, ToolResult } from './types.ts';

export type RunOptions = {
  taskFile: string;
  driver: string | Driver;
  mode?: Mode;
  maxTurns?: number;
  /** Override the task's target directory (bench uses this for the baseline copy). */
  workspace?: string;
  pluginRoot?: string;
  cwd?: string;
  maxOutputTokens?: number;
};

export type RunSummary = {
  runId: string;
  task: string;
  driver: string;
  model: string | null;
  mode: Mode;
  workspace: string;
  status: 'green' | 'red' | 'error';
  reason: string;
  turns: number;
  toolCalls: number;
  blocked: number;
  changed: string[];
  red: string[];
  gates: GateReport['gates'];
  standardsPercent: number;
  tokenReport: string;
};

export async function runTask(opts: RunOptions): Promise<RunSummary> {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? 'jit';
  const maxTurns = opts.maxTurns ?? 40;
  const task = loadTask(opts.taskFile, cwd);
  const workspace = opts.workspace ?? taskTarget(task, cwd);
  const driver = typeof opts.driver === 'string' ? await loadDriver(opts.driver) : opts.driver;
  const registry = await loadRegistry(opts.pluginRoot);

  prepareWorkspace(task, workspace);

  const runId = `${task.id}-${driver.name}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(REPO_ROOT, 'runs', runId);
  mkdirSync(join(runDir, 'artifacts'), { recursive: true });
  const log = (event: Record<string, unknown>): void =>
    appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);

  const ledger = new RedLedger();
  const contract = surfaceOf(loadApi(workspace));
  const before = snapshot(workspace);
  let artifactSeq = 0;
  const ctx: RunContext = {
    workspace,
    runDir,
    task,
    mode,
    ledger,
    contract,
    scope: task.scope,
    rules: registry.rules,
    artifact(name, content) {
      const file = `${String(++artifactSeq).padStart(3, '0')}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      writeFileSync(join(runDir, 'artifacts', file), content);
      return file;
    },
  };

  const specs = toolSpecs(registry.tools.values());
  const keyOf = (call: ToolCall): string | undefined => {
    const tool = registry.tools.get(call.name);
    const parsed = tool?.input.safeParse(call.args);
    return tool?.contextKey && parsed?.success ? tool.contextKey(parsed.data) : undefined;
  };
  const system = buildSystemPrompt(task, registry.rules, mode, workspace);
  const kickoff: Message = {
    role: 'user',
    text:
      task.kind === 'greenfield'
        ? 'Implement the task in this freshly scaffolded API. Start with list_files.'
        : 'Apply the change to this existing API. Start with list_files and search to find the code involved.',
  };
  const messages: Message[] = [kickoff];
  const shadow: Message[] = [kickoff]; // the non-JIT counterfactual of the same conversation
  const turns: TurnTokens[] = [];
  let toolCallCount = 0;
  let blocked = 0;
  let status: RunSummary['status'] = 'red';
  let reason = `turn budget (${maxTurns}) exhausted before the gates went green`;
  let lastGates: GateReport | null = null;

  log({ type: 'start', runId, task: task.id, driver: driver.name, model: driver.model ?? null, mode, workspace, tools: specs.map((s) => s.name), hooks: registry.hooks.map((h) => h.name), rules: registry.rules.map((r) => r.id), systemChars: system.length });

  for (let turn = 1; turn <= maxTurns; turn++) {
    const sent = mode === 'jit' ? compactHistory(messages, keyOf) : messages;
    const req = { system, messages: sent, tools: specs, maxOutputTokens: opts.maxOutputTokens ?? 8192 };
    const shadowReq = { system: buildSystemPrompt(task, registry.rules, 'baseline', workspace), messages: shadow, tools: specs };

    let res;
    try {
      res = await driver.complete(req);
    } catch (err) {
      status = 'error';
      reason = `driver error: ${(err as Error).message}`;
      log({ type: 'driver-error', turn, error: (err as Error).message });
      break;
    }
    turns.push({
      turn,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      estimatedInput: estimateTokens(req),
      estimatedShadowBaseline: estimateTokens(shadowReq),
    });
    log({ type: 'model', turn, text: res.text.slice(0, 2000), toolCalls: res.toolCalls.map((c) => c.name), usage: res.usage });

    const assistant: Message = { role: 'assistant', text: res.text, toolCalls: res.toolCalls };
    messages.push(assistant);
    shadow.push(assistant);

    // A reply cut off at the output limit is not a claim of completion: say so and continue.
    if (res.truncated && res.toolCalls.length === 0) {
      log({ type: 'truncated', turn });
      const nudge: Message = {
        role: 'user',
        text: 'Your last reply was cut off at the output-token limit before any tool call. Continue in smaller steps: one file per call, edit_file for small changes.',
      };
      messages.push(nudge);
      shadow.push(nudge);
      continue;
    }

    if (res.toolCalls.length > 0) {
      const results: ToolResult[] = [];
      const rawResults: ToolResult[] = [];
      for (const call of res.toolCalls) {
        toolCallCount++;
        const out = await executeCall(call, registry, ctx, log, turn);
        if (out.blocked) blocked++;
        results.push({ id: call.id, name: call.name, content: mode === 'jit' ? out.text : out.raw, isError: out.isError });
        rawResults.push({ id: call.id, name: call.name, content: out.raw, isError: out.isError });
      }
      messages.push({ role: 'tool', results });
      shadow.push({ role: 'tool', results: rawResults });
      continue;
    }

    // The model says it is done. Only the gates can agree.
    lastGates = await runGates({
      workspace,
      rules: registry.rules,
      contract,
      changed: changedFiles(before, snapshot(workspace)),
      red: ledger.red,
    });
    log({ type: 'gates', turn, green: lastGates.green, gates: lastGates.gates });
    if (lastGates.green) {
      status = 'green';
      reason = 'all gates green';
      break;
    }
    const feedback = [
      'Not finished. The harness ran the gates:',
      formatGates(lastGates),
      lastGates.standards.verdict !== 'pass' ? formatFailures(lastGates.standards) : '',
      'Fix the failures, then reply with no tool calls again.',
    ]
      .filter(Boolean)
      .join('\n');
    messages.push({ role: 'user', text: feedback });
    shadow.push({ role: 'user', text: feedback });
  }

  if (!lastGates || status !== 'green') {
    lastGates = await runGates({ workspace, rules: registry.rules, contract, changed: changedFiles(before, snapshot(workspace)), red: ledger.red });
    if (status !== 'error' && lastGates.green) reason += ' (gates happen to be green, but the model never asked for verification)';
  }

  const changed = changedFiles(before, snapshot(workspace));
  const tokenPath = join(REPO_ROOT, 'tokens', `${runId}.json`);
  writeJson(tokenPath, buildRunReport({ runId, task: task.id, driver: driver.name, mode }, turns));
  writeJson(join(runDir, 'ledger.json'), ledger.toJSON());
  writeJson(join(runDir, 'contract.json'), contract);

  const summary: RunSummary = {
    runId,
    task: task.id,
    driver: driver.name,
    model: driver.model ?? null,
    mode,
    workspace,
    status,
    reason,
    turns: turns.length,
    toolCalls: toolCallCount,
    blocked,
    changed,
    red: [...ledger.red].sort(),
    gates: lastGates.gates,
    standardsPercent: lastGates.standards.percent,
    tokenReport: `tokens/${runId}.json`,
  };
  writeJson(join(runDir, 'summary.json'), summary);
  writeFileSync(join(runDir, 'standards.txt'), `${formatStandards(lastGates.standards)}\n`);
  writeFileSync(join(runDir, 'tests.log'), lastGates.tests.raw);
  log({ type: 'end', status, reason });
  return summary;
}

/** Tool args for the run log, with long strings (file contents) shortened. */
function summarizeArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v]));
}

function prepareWorkspace(task: Task, workspace: string): void {
  if (task.kind === 'greenfield') {
    if (!existsSync(join(workspace, 'src'))) scaffoldGreenfield(workspace, task.id);
    return;
  }
  if (!existsSync(workspace)) throw new Error(`brownfield target does not exist: ${workspace}`);
}

async function executeCall(
  call: ToolCall,
  registry: Registry,
  ctx: RunContext,
  log: (e: Record<string, unknown>) => void,
  turn: number,
): Promise<{ text: string; raw: string; isError: boolean; blocked: boolean }> {
  const fail = (msg: string, blocked = false): { text: string; raw: string; isError: boolean; blocked: boolean } => ({ text: msg, raw: msg, isError: true, blocked });

  const tool = registry.tools.get(call.name);
  if (!tool) return fail(`unknown tool "${call.name}". Available: ${[...registry.tools.keys()].join(', ')}`);

  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
    log({ type: 'tool', turn, tool: call.name, outcome: 'invalid-args', issues });
    return fail(`invalid arguments for ${call.name}: ${issues}`);
  }

  for (const hook of registry.hooks) {
    if (hook.event !== 'pre' || (hook.tools && !hook.tools.includes(call.name))) continue;
    const d = await hook.run({ tool: call.name, args: parsed.data }, ctx);
    log({ type: 'hook', turn, hook: hook.name, event: 'pre', tool: call.name, decision: d.action, ...(d.action === 'block' ? { feedback: d.feedback } : d.action === 'record' ? { note: d.note } : {}) });
    if (d.action === 'block') return fail(`BLOCKED by ${hook.name}: ${d.feedback}`, true);
  }

  let text: string;
  let raw: string;
  let isError = false;
  try {
    const out = await tool.run(parsed.data, ctx);
    text = typeof out === 'string' ? out : out.text;
    raw = typeof out === 'string' ? out : out.raw;
  } catch (err) {
    text = raw = `${call.name} failed: ${(err as Error).message}`;
    isError = true;
  }

  const notes: string[] = [];
  for (const hook of registry.hooks) {
    if (hook.event !== 'post' || (hook.tools && !hook.tools.includes(call.name))) continue;
    const d = await hook.run({ tool: call.name, args: parsed.data, result: { content: raw, isError } }, ctx);
    // 'record' goes to the run log only; 'block' after the fact flags the result to the model.
    log({ type: 'hook', turn, hook: hook.name, event: 'post', tool: call.name, decision: d.action, ...(d.action === 'record' ? { note: d.note } : {}) });
    if (d.action === 'block') {
      notes.push(`[${hook.name}] ${d.feedback}`);
      isError = true;
    }
  }
  if (notes.length) {
    text = `${text}\n${notes.join('\n')}`;
    raw = `${raw}\n${notes.join('\n')}`;
  }
  log({ type: 'tool', turn, tool: call.name, args: summarizeArgs(parsed.data), outcome: isError ? 'error' : 'ok', chars: { text: text.length, raw: raw.length }, ...(isError ? { error: text.slice(0, 300) } : {}) });
  return { text, raw, isError, blocked: false };
}
