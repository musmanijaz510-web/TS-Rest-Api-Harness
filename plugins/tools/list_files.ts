import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, keyPath, resolveInWorkspace } from '#harness/plugin-api.ts';

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);
const MAX = 300;

export default defineTool({
  name: 'list_files',
  description: 'List files under a directory of the API (recursive, skips node_modules). Returns one path per line with byte size.',
  input: z.object({ dir: z.string().default('.').describe('Directory relative to the API root') }),
  contextKey: ({ dir }) => `list:${keyPath(dir)}`,
  run({ dir }, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, dir);
    if ('error' in loc) throw new Error(loc.error);
    if (!existsSync(loc.abs)) throw new Error(`no such directory: ${dir}`);
    const out: string[] = [];
    const visit = (abs: string, rel: string): void => {
      for (const name of readdirSync(abs).sort()) {
        if (SKIP.has(name) || name.startsWith('.')) continue;
        const a = join(abs, name);
        const r = rel ? `${rel}/${name}` : name;
        const st = statSync(a);
        if (st.isDirectory()) visit(a, r);
        else out.push(`${r} ${st.size}b`);
      }
    };
    visit(loc.abs, loc.rel === '' ? '' : loc.rel);
    const extra = out.length > MAX ? [`... ${out.length - MAX} more`] : [];
    return [...out.slice(0, MAX), ...extra].join('\n') || '(empty)';
  },
});
