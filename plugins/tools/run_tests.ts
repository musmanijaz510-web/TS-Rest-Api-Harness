import { existsSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, resolveInWorkspace, runTests } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'run_tests',
  description:
    'Run test files with the harness runner (node --test, one process per file). Omit files to run all. A failing result is what unlocks edits to mapped source files.',
  input: z.object({ files: z.array(z.string()).optional().describe('Test file paths relative to the API root') }),
  contextKey: () => 'tests',
  run({ files }, ctx) {
    // Paths become argv for node: validate them so nothing can smuggle in a flag.
    const targets = (files ?? []).map((f) => {
      const loc = resolveInWorkspace(ctx.workspace, f);
      if ('error' in loc) throw new Error(loc.error);
      if (!loc.rel.endsWith('.test.ts') || !existsSync(loc.abs)) throw new Error(`not an existing *.test.ts file: ${f}`);
      return `./${loc.rel}`;
    });
    const run = runTests(ctx.workspace, targets);
    for (const r of run.results) ctx.ledger.record(r.file, r.ok);
    const log = ctx.artifact('tests.tap', run.raw);
    const lines = run.results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}: ${r.summary}`);
    const text = `${lines.join('\n') || 'no test files found'}\nraw log: read_artifact {"name":"${log}"}`;
    return { text, raw: `${text}\n${run.raw}` };
  },
});
