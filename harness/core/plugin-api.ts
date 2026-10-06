// The only module plugins need to import. Stable surface for tools, hooks and rules.
import { posix } from 'node:path';
import type { z } from 'zod';
import type { Hook, Rule, RunContext, Tool, ToolOutput } from './types.ts';

export type { Hook, HookDecision, HookEvent, Rule, RuleResult, Finding, RunContext, Tool, ToolOutput } from './types.ts';
export type { ApiModel, Route, SourceInfo, FunctionNode } from './api-model.ts';
export { walk, lineOf, ctxCalls, reqCalls, stringValue, handlerSource, isFunctionNode, loadApi } from './api-model.ts';
export { mappedTests, isGatedSource } from './ledger.ts';
export { surfaceOf, breakingChanges } from './contract.ts';
export { resolveInWorkspace, matchesScope, PROTECTED_FILES } from './workspace.ts';
export { runTests } from './testrun.ts';
export { runStandards, formatStandards, formatFailures, summaryLines } from './standards.ts';
export { default as ts } from 'typescript';

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: RunContext): ToolOutput | Promise<ToolOutput>;
  contextKey?(input: z.infer<S>): string | undefined;
}): Tool<z.infer<S>> {
  // S's output type is exactly z.infer<S>; TypeScript cannot see that through the generic.
  return tool as unknown as Tool<z.infer<S>>;
}

export const defineHook = (hook: Hook): Hook => hook;
export const defineRule = (rule: Rule): Rule => rule;

/** Normalized workspace-relative path for context keys ("./src//a.ts" -> "src/a.ts"). */
export const keyPath = (p: string): string => posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '');

/** Read a string field from untyped tool args (hooks see args before the tool narrows them). */
export function argString(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
