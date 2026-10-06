// Records every successful write with its size, so the run log shows exactly
// what the model changed and in which order.
import { argString, defineHook } from '#harness/plugin-api.ts';
import { WRITE_TOOLS } from '../_shared/proposed.ts';

export default defineHook({
  name: 'write-journal',
  event: 'post',
  tools: WRITE_TOOLS,
  run(e) {
    if (e.result?.isError) return { action: 'pass' };
    return { action: 'record', note: `journal: ${e.tool} ${argString(e.args, 'path') ?? '?'}` };
  },
});
