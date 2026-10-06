import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, keyPath, resolveInWorkspace } from '#harness/plugin-api.ts';

const MAX_LINES = 300;

export default defineTool({
  name: 'read_file',
  description: `Read a file (or a line range) from the API. Returns at most ${MAX_LINES} lines; ask for a range for larger files.`,
  input: z.object({
    path: z.string().describe('File path relative to the API root'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  }),
  contextKey: ({ path, startLine, endLine }) =>
    startLine === undefined && endLine === undefined ? `file:${keyPath(path)}` : `file:${keyPath(path)}#${startLine ?? 1}-${endLine ?? 'end'}`,
  run({ path, startLine, endLine }, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, path);
    if ('error' in loc) throw new Error(loc.error);
    if (!existsSync(loc.abs)) throw new Error(`no such file: ${path}`);
    const lines = readFileSync(loc.abs, 'utf8').split('\n');
    const from = (startLine ?? 1) - 1;
    const to = Math.min(endLine ?? lines.length, from + MAX_LINES, lines.length);
    const body = lines.slice(from, to).join('\n');
    const header = from > 0 || to < lines.length ? `# ${loc.rel} lines ${from + 1}-${to} of ${lines.length}\n` : '';
    return { text: `${header}${body}`, raw: lines.join('\n') };
  },
});
