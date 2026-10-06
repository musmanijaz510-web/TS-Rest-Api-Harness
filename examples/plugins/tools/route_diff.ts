// Example tool plugin. Install: cp examples/plugins/tools/route_diff.ts plugins/tools/
// Shows routes and exported schemas added or removed since the run started.
import { z } from 'zod';
import { defineTool, loadApi, surfaceOf } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'route_diff',
  description: 'Compare the API surface now with the surface captured at the start of the run (routes and exported schemas).',
  input: z.object({}),
  run(_input, ctx) {
    const now = surfaceOf(loadApi(ctx.workspace));
    const added = now.routes.filter((r) => !ctx.contract.routes.includes(r));
    const removed = ctx.contract.routes.filter((r) => !now.routes.includes(r));
    const schemas = Object.keys(now.schemas).filter((s) => !(s in ctx.contract.schemas));
    return [
      `routes added: ${added.join(', ') || 'none'}`,
      `routes removed: ${removed.join(', ') || 'none'}`,
      `schemas added: ${schemas.join(', ') || 'none'}`,
    ].join('\n');
  },
});
