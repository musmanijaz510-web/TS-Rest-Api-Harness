// What a write tool is about to put on disk, so pre-hooks can judge the result
// before it lands. Shared by the built-in hooks; not itself a plugin.
import { existsSync, readFileSync } from 'node:fs';
import { argString, resolveInWorkspace, type RunContext } from '#harness/plugin-api.ts';

export const WRITE_TOOLS = ['write_file', 'edit_file'];

export function proposedWrite(ctx: RunContext, tool: string, args: unknown): { rel: string; content: string } | null {
  const path = argString(args, 'path');
  if (path === undefined) return null;
  const loc = resolveInWorkspace(ctx.workspace, path);
  if ('error' in loc) return null;
  if (tool === 'write_file') {
    const content = argString(args, 'content');
    return content === undefined ? null : { rel: loc.rel, content };
  }
  if (tool === 'edit_file') {
    const oldText = argString(args, 'old');
    const newText = argString(args, 'new');
    if (oldText === undefined || newText === undefined || !existsSync(loc.abs)) return null;
    const current = readFileSync(loc.abs, 'utf8');
    if (current.split(oldText).length !== 2) return null; // the tool will report the ambiguity
    return { rel: loc.rel, content: current.replace(oldText, () => newText) };
  }
  return null;
}
