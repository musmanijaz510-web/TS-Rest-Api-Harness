import { z } from 'zod';
import { defineTool, formatFailures, formatStandards, loadApi, runStandards, summaryLines } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'run_checks',
  description: 'Run every API standards rule on the workspace. Returns failing lines with file:line, or the summary when all pass.',
  input: z.object({}),
  contextKey: () => 'checks',
  async run(_input, ctx) {
    const report = await runStandards(loadApi(ctx.workspace), ctx.rules);
    const full = formatStandards(report);
    const path = ctx.artifact('standards.txt', full);
    const text = report.verdict === 'pass' ? summaryLines(report).join('\n') : formatFailures(report);
    return { text: `${text}\nfull report: read_artifact {"name":"${path}"}`, raw: full };
  },
});
