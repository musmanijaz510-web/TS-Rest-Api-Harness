// A non-test source file may only be written once a mapped test has been seen
// failing by the harness's own runner (run_tests). Never on the model's word.
import { argString, defineHook, isGatedSource, loadApi, mappedTests, resolveInWorkspace } from '#harness/plugin-api.ts';
import { WRITE_TOOLS } from '../_shared/proposed.ts';

export default defineHook({
  name: 'observed-red',
  event: 'pre',
  tools: WRITE_TOOLS,
  run(e, ctx) {
    const loc = resolveInWorkspace(ctx.workspace, argString(e.args, 'path') ?? '');
    if ('error' in loc || !isGatedSource(loc.rel)) return { action: 'pass' };
    const tests = mappedTests(loadApi(ctx.workspace), loc.rel);
    if (tests.some((t) => ctx.ledger.wasRed(t))) return { action: 'pass' };
    const stem = loc.rel.split('/').at(-2) === 'src' ? (loc.rel.split('/').pop() ?? '').replace(/\.ts$/, '') : (loc.rel.split('/').at(-2) ?? 'feature');
    return {
      action: 'block',
      feedback: tests.length
        ? `${loc.rel}: mapped tests ${tests.join(', ')} have not been seen failing. Add a test for the new behaviour, run_tests it, see it FAIL, then retry.`
        : `${loc.rel}: no test maps to this file. Write test/${stem}.test.ts (or a test importing ${loc.rel}), run_tests it, see it FAIL, then retry.`,
    };
  },
});
