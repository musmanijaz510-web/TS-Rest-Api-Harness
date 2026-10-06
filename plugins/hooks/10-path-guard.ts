// Writes stay inside the workspace and the task's scope, and never touch
// package manifests, compiler config or lockfiles.
import { PROTECTED_FILES, argString, defineHook, matchesScope, resolveInWorkspace } from '#harness/plugin-api.ts';
import { WRITE_TOOLS } from '../_shared/proposed.ts';

export default defineHook({
  name: 'path-guard',
  event: 'pre',
  tools: WRITE_TOOLS,
  run(e, ctx) {
    const path = argString(e.args, 'path') ?? '';
    const loc = resolveInWorkspace(ctx.workspace, path);
    if ('error' in loc) return { action: 'block', feedback: loc.error };
    const base = loc.rel.split('/').pop() ?? '';
    if (PROTECTED_FILES.includes(base)) return { action: 'block', feedback: `${loc.rel} is protected: dependencies and compiler settings are not the model's to change` };
    if (!matchesScope(loc.rel, ctx.scope)) {
      return { action: 'block', feedback: `${loc.rel} is outside the task scope (${ctx.scope.join(', ')})` };
    }
    return { action: 'pass' };
  },
});
