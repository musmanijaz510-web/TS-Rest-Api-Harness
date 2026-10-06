// What goes into the context window, and what stays out of it.
// JIT mode: a small fixed prompt; everything else is fetched by tools on demand and
// old turns are compacted. Baseline mode: the same task with fetchers and compaction
// off - the whole workspace and every standards doc front-loaded, raw tool output kept.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { listTsFiles } from './api-model.ts';
import { REPO_ROOT } from './registry.ts';
import type { DriverRequest, Message, Mode, Rule, Tool, ToolCall, ToolSpec } from './types.ts';
import type { Task } from './task.ts';

export function toolSpecs(tools: Iterable<Tool>): ToolSpec[] {
  return [...tools].map((t) => {
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, parameters: schema };
  });
}

function taskBrief(task: Task): string {
  const { source: _source, ...rest } = task;
  return JSON.stringify(rest);
}

export function buildSystemPrompt(task: Task, rules: readonly Rule[], mode: Mode, workspace: string): string {
  const core = [
    'You are the model inside a governing harness. You edit one TypeScript REST API (Hono + Zod, Node ESM; relative imports use the .ts extension; tests use node:test and node:assert/strict and call app.request()).',
    'All paths are relative to the API root. The harness enforces, in code:',
    '1. A non-test source file can only be written after a mapped test was seen FAILING by run_tests. A test maps to a source if it imports it or its stem matches the source file or directory name (test/users.test.ts -> src/users/*). Write the test, run_tests it, see it fail, then write the source.',
    '2. Writes outside the task scope, to package.json/tsconfig.json, or that remove existing routes or schema fields are refused.',
    '3. You are finished only when run_checks reports 100% and every test passes. When you believe you are finished, reply with no tool calls; the harness then verifies.',
    `Standards rules: ${rules.map((r) => r.id).join(', ')}. Call the standards tool once (with rule ids, or none for all) to learn how to comply.`,
    mode === 'jit'
      ? 'Nothing is preloaded: use list_files, read_file and search to fetch exactly what the next step needs. Prefer edit_file for small changes.'
      : '',
    `Task: ${taskBrief(task)}`,
  ].filter(Boolean);
  if (mode === 'jit') return core.join('\n');

  // Baseline: front-load everything a non-JIT harness would.
  const docs: string[] = [];
  const standardsDoc = join(REPO_ROOT, 'docs', 'standards.md');
  if (existsSync(standardsDoc)) docs.push(`# docs/standards.md\n${readFileSync(standardsDoc, 'utf8')}`);
  for (const r of rules) docs.push(`# rule ${r.id}\n${r.description}\n${r.hint}`);
  const files = listTsFiles(workspace).map((p) => `# ${p}\n${readFileSync(join(workspace, p), 'utf8')}`);
  return [...core, '--- STANDARDS ---', ...docs, '--- WORKSPACE ---', ...files].join('\n\n');
}

const ELIDE_ARG_OVER = 300;
/** Verbatim tool output kept in context before the oldest live results are compacted anyway (~12k tokens). */
export const CONTEXT_BUDGET_CHARS = 48_000;
const KEEP_RECENT = 2;

/** What a tool call's result is about (see Tool.contextKey). Undefined = no key. */
export type KeyOf = (call: ToolCall) => string | undefined;

/** `later` makes `earlier` stale: same key, or `earlier` is a sub-part of it (file:a#1-50 under file:a). */
const supersedes = (later: string, earlier: string): boolean => earlier === later || earlier.startsWith(`${later}#`);

/**
 * Compact what is stale, keep what is live. A tool result (and the large arguments of the
 * call that produced it) is compacted when a later call has the same context key (a newer
 * read or write of the same file, a newer test run), when it was an error, or when the live
 * set exceeds the budget (oldest first). The newest exchanges always stay verbatim.
 */
export function compactHistory(messages: readonly Message[], keyOf: KeyOf = () => undefined, budget = CONTEXT_BUDGET_CHARS): Message[] {
  const calls: { id: string; key: string | undefined; msg: number }[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') for (const c of m.toolCalls) calls.push({ id: c.id, key: keyOf(c), msg: i });
  });
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const recentFrom = toolIdx.length > KEEP_RECENT ? (toolIdx[toolIdx.length - KEEP_RECENT] ?? 0) - 1 : 0;

  const stale = new Set<string>();
  calls.forEach((c, i) => {
    if (c.key && calls.slice(i + 1).some((later) => later.key && supersedes(later.key, c.key ?? ''))) stale.add(c.id);
  });
  for (const m of messages) {
    if (m.role === 'tool') for (const r of m.results) if (r.isError) stale.add(r.id);
  }

  // Budget: if live verbatim output is still too large, compact the oldest live results.
  const sizeOf = new Map<string, number>();
  for (const m of messages) if (m.role === 'tool') for (const r of m.results) sizeOf.set(r.id, r.content.length);
  let live = calls.filter((c) => !stale.has(c.id)).reduce((a, c) => a + (sizeOf.get(c.id) ?? 0), 0);
  for (const c of calls) {
    if (live <= budget || c.msg >= recentFrom) break;
    if (!stale.has(c.id)) {
      stale.add(c.id);
      live -= sizeOf.get(c.id) ?? 0;
    }
  }

  return messages.map((m, i) => {
    if (i >= recentFrom) return m; // newest exchanges stay verbatim
    if (m.role === 'tool') {
      return {
        role: 'tool',
        results: m.results.map((r) => {
          if (!stale.has(r.id) || r.content.length <= 200) return r;
          const first = r.content.split('\n', 1)[0] ?? '';
          return { ...r, content: `${first.slice(0, 200)} [superseded or compacted, ${r.content.length} chars]` };
        }),
      };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        text: m.text.length > 400 ? `${m.text.slice(0, 400)} [compacted]` : m.text,
        toolCalls: m.toolCalls.map((c) => (stale.has(c.id) ? { ...c, args: elideArgs(c.args) } : c)),
      };
    }
    return m.text.length > 1500 ? { role: 'user', text: `${m.text.slice(0, 1500)} [compacted]` } : m;
  });
}

function elideArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > ELIDE_ARG_OVER ? `[${v.length} chars elided]` : v;
  }
  return out;
}

/** Provider-independent size estimate (~4 chars/token), used identically for baseline and actual. */
export function estimateTokens(req: Pick<DriverRequest, 'system' | 'messages' | 'tools'>): number {
  return Math.ceil(JSON.stringify([req.system, req.messages, req.tools]).length / 4);
}
