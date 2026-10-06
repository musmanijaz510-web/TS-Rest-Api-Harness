import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../harness/core/registry.ts';
import type { Driver, DriverRequest, DriverResponse, ToolCall } from '../harness/core/types.ts';

export const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'good-api');

/** A scratch dir inside the repo (so the API's imports resolve to the root node_modules). */
export function scratch(name: string): string {
  const dir = join(REPO_ROOT, 'runs', `_test-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function copyFixture(dest: string): string {
  cpSync(FIXTURE, dest, { recursive: true });
  return dest;
}

export const cleanup = (dir: string): void => rmSync(dir, { recursive: true, force: true });

export function writeTask(dir: string, task: Record<string, unknown>): string {
  const file = join(dir, 'task.json');
  writeFileSync(file, JSON.stringify(task));
  return file;
}

let seq = 0;
export const call = (name: string, args: unknown): ToolCall => ({ id: `call_${++seq}`, name, args });

/**
 * A provider-free driver that replays a script of turns. Each entry is the list of
 * tool calls for that turn; an empty list means "I am done". Requests are recorded.
 */
export function scriptedDriver(turns: (ToolCall[] | 'truncated')[]): Driver & { requests: DriverRequest[] } {
  const requests: DriverRequest[] = [];
  let i = 0;
  return {
    name: 'scripted',
    requests,
    async complete(req): Promise<DriverResponse> {
      requests.push(req);
      const step = turns[i++] ?? [];
      const inputTokens = Math.ceil(JSON.stringify(req).length / 4);
      if (step === 'truncated') return { text: '', toolCalls: [], usage: { inputTokens, outputTokens: 10 }, truncated: true };
      return { text: step.length ? '' : 'done', toolCalls: step, usage: { inputTokens, outputTokens: 10 } };
    },
  };
}
