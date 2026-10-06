import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '#harness/plugin-api.ts';

const MAX_LINES = 200;

export default defineTool({
  name: 'read_artifact',
  description: 'Read a raw log the harness saved during this run (e.g. the full test or standards output), by the name a tool result gave you.',
  input: z.object({ name: z.string(), startLine: z.number().int().min(1).optional() }),
  contextKey: ({ name, startLine }) => `artifact:${name}#${startLine ?? 1}`,
  run({ name, startLine }, ctx) {
    const file = join(ctx.runDir, 'artifacts', basename(name)); // basename: no path traversal
    if (!existsSync(file)) throw new Error(`no artifact named ${basename(name)} in this run`);
    const lines = readFileSync(file, 'utf8').split('\n');
    const from = (startLine ?? 1) - 1;
    const to = Math.min(lines.length, from + MAX_LINES);
    const header = from > 0 || to < lines.length ? `# lines ${from + 1}-${to} of ${lines.length}\n` : '';
    return { text: `${header}${lines.slice(from, to).join('\n')}`, raw: lines.join('\n') };
  },
});
