import { z } from 'zod';
import { defineTool, keyPath, loadApi, mappedTests, resolveInWorkspace } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'map_tests',
  description: 'Show which test files map to a source file and whether the harness has seen each fail. Use before editing existing code.',
  input: z.object({ path: z.string() }),
  contextKey: ({ path }) => `map:${keyPath(path)}`,
  run({ path }, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, path);
    if ('error' in loc) throw new Error(loc.error);
    const tests = mappedTests(loadApi(ctx.workspace), loc.rel);
    if (!tests.length) return `${loc.rel}: no mapped tests. Write test/<name>.test.ts that imports it.`;
    return tests.map((t) => `${t} ${ctx.ledger.wasRed(t) ? 'observed-red' : 'not yet observed red'}`).join('\n');
  },
});
