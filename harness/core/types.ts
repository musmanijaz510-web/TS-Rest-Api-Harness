// Provider-neutral types. Nothing in this file (or anything that imports only
// this file) may know which model vendor is on the other side of a Driver.
import type { z } from 'zod';
import type { ApiModel } from './api-model.ts';
import type { RedLedger } from './ledger.ts';
import type { Surface } from './contract.ts';
import type { Task } from './task.ts';

// ---------------------------------------------------------------- conversation
export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  /** Adapter-owned data the provider requires echoed back verbatim (e.g. reasoning signatures). Core never reads it. */
  meta?: Record<string, unknown>;
};
export type ToolResult = { id: string; name: string; content: string; isError: boolean };

export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

/** A tool as the model sees it. `parameters` is plain JSON Schema, derived from the tool's Zod input. */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type DriverRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
};

export type DriverResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** The reply was cut off at the output-token limit. Never a signal that the work is done. */
  truncated?: boolean;
};

export interface Driver {
  readonly name: string;
  /** Resolved model and route, for run logs only (e.g. "vendor/model via gateway"). */
  readonly model?: string;
  complete(req: DriverRequest): Promise<DriverResponse>;
}

/** Default export of a file in harness/drivers/. Reads its own config from env. */
export type DriverFactory = (env: NodeJS.ProcessEnv) => Driver;

// ---------------------------------------------------------------- run context
export type Mode = 'jit' | 'baseline';

export interface RunContext {
  /** Absolute path of the API being governed. All tool paths are relative to it. */
  readonly workspace: string;
  /** Absolute path of runs/<runId>; raw logs land here. */
  readonly runDir: string;
  readonly task: Task;
  readonly mode: Mode;
  readonly ledger: RedLedger;
  /** Route + schema surface captured before the model touched anything. */
  readonly contract: Surface;
  /** Globs (relative to workspace) the model may write. */
  readonly scope: readonly string[];
  readonly rules: readonly Rule[];
  /** Persist raw output to runs/<runId>/artifacts/; returns the name the read_artifact tool accepts. */
  artifact(name: string, content: string): string;
}

// ---------------------------------------------------------------- tools
/** `text` goes to the model in JIT mode; `raw` goes to the model in baseline mode. */
export type ToolOutput = string | { text: string; raw: string };

export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I, ctx: RunContext): ToolOutput | Promise<ToolOutput>;
  /**
   * What this call's result is about, for compaction: a later call with the same key makes
   * this result stale (e.g. "file:src/app.ts"; "file:src/app.ts#1-50" is a part of it).
   * Omit to keep results until the context budget forces compaction.
   */
  contextKey?(input: I): string | undefined;
}

// ---------------------------------------------------------------- hooks
export type HookEvent = {
  tool: string;
  args: unknown;
  /** Present for post hooks only. */
  result?: { content: string; isError: boolean };
};

export type HookDecision =
  | { action: 'pass' }
  | { action: 'block'; feedback: string }
  | { action: 'record'; note: string };

export interface Hook {
  readonly name: string;
  readonly event: 'pre' | 'post';
  /** Tool names this hook applies to; omitted = every tool. */
  readonly tools?: readonly string[];
  run(event: HookEvent, ctx: RunContext): HookDecision | Promise<HookDecision>;
}

// ---------------------------------------------------------------- standards rules
export type Finding = { file: string; line?: number; ok: boolean; message?: string };

export type RuleResult = {
  /** What one subject is, e.g. "handlers", "routes", "errors". */
  unit: string;
  findings: Finding[];
  /** Set when the rule applies but could not run. Never reported as green. */
  unproven?: string;
};

export interface Rule {
  readonly id: string;
  readonly description: string;
  /** Short how-to-comply text, fetched on demand by the model (never front-loaded). */
  readonly hint: string;
  /** Optional rules report n/a when they find no subjects; mandatory rules report UNPROVEN. */
  readonly optional?: boolean;
  check(api: ApiModel): RuleResult | Promise<RuleResult>;
}
