import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool, keyPath, resolveInWorkspace } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the API with the full content given. Subject to scope, observed-red and contract gates.',
  input: z.object({ path: z.string(), content: z.string() }),
  contextKey: ({ path }) => `file:${keyPath(path)}`,
  run({ path, content }, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, path);
    if ('error' in loc) throw new Error(loc.error);
    mkdirSync(dirname(loc.abs), { recursive: true });
    writeFileSync(loc.abs, content);
    return `wrote ${loc.rel} (${content.split('\n').length} lines)`;
  },
});
