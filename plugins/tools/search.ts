import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, loadApi } from '#harness/plugin-api.ts';

const MAX = 40;

export default defineTool({
  name: 'search',
  description: 'Search the API\'s TypeScript files for a literal string (case-sensitive). Returns file:line: text, at most 40 hits.',
  input: z.object({ query: z.string().min(1) }),
  contextKey: ({ query }) => `search:${query}`,
  run({ query }, ctx) {
    const hits: string[] = [];
    for (const f of loadApi(ctx.workspace).files) {
      readFileSync(join(ctx.workspace, f.path), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.includes(query)) hits.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
    }
    const extra = hits.length > MAX ? [`... ${hits.length - MAX} more; narrow the query`] : [];
    return [...hits.slice(0, MAX), ...extra].join('\n') || 'no matches';
  },
});
