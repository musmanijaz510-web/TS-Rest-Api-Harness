// Contract lock: a proposed write is evaluated against the route and schema
// surface captured before the run. Removing a route or a schema field is refused
// before it reaches disk.
import { breakingChanges, defineHook, loadApi, surfaceOf } from '#harness/plugin-api.ts';
import { WRITE_TOOLS, proposedWrite } from '../_shared/proposed.ts';

export default defineHook({
  name: 'contract-lock',
  event: 'pre',
  tools: WRITE_TOOLS,
  run(e, ctx) {
    if (ctx.contract.routes.length === 0 && Object.keys(ctx.contract.schemas).length === 0) return { action: 'pass' };
    const next = proposedWrite(ctx, e.tool, e.args);
    if (!next || !next.rel.endsWith('.ts')) return { action: 'pass' };
    const breaks = breakingChanges(ctx.contract, surfaceOf(loadApi(ctx.workspace, new Map([[next.rel, next.content]]))));
    if (breaks.length === 0) return { action: 'pass' };
    return {
      action: 'block',
      feedback: `this write would break the existing contract: ${breaks.join('; ')}. Existing routes and schema fields may be added to, never removed. If you are moving code, write the new location first.`,
    };
  },
});
