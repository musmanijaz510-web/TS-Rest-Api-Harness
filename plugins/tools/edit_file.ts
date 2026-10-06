import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, keyPath, resolveInWorkspace } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'edit_file',
  description: 'Replace one exact, unique occurrence of `old` with `new` in a file. Cheaper than write_file for small changes.',
  input: z.object({ path: z.string(), old: z.string().min(1), new: z.string() }),
  contextKey: ({ path }) => `file:${keyPath(path)}`,
  run(input, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, input.path);
    if ('error' in loc) throw new Error(loc.error);
    if (!existsSync(loc.abs)) throw new Error(`no such file: ${input.path}`);
    const current = readFileSync(loc.abs, 'utf8');
    const count = current.split(input.old).length - 1;
    if (count !== 1) throw new Error(`\`old\` must occur exactly once in ${loc.rel}; found ${count}`);
    writeFileSync(loc.abs, current.replace(input.old, () => input.new));
    return `edited ${loc.rel}`;
  },
});
