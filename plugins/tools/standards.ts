import { z } from 'zod';
import { defineTool } from '#harness/plugin-api.ts';

export default defineTool({
  name: 'standards',
  description: 'Fetch how to comply with standards rules. Pass the rule ids you are working on; omit `rules` to get every rule in one call.',
  input: z.object({ rules: z.array(z.string()).optional().describe('Rule ids; omit for all rules') }),
  contextKey: ({ rules }) => `standards:${[...(rules ?? [])].sort().join(',')}`,
  run({ rules }, ctx) {
    const unknown = (rules ?? []).filter((id) => !ctx.rules.some((r) => r.id === id));
    if (unknown.length) throw new Error(`unknown rule(s) ${unknown.join(', ')}. Rules: ${ctx.rules.map((r) => r.id).join(', ')}`);
    const picked = rules?.length ? ctx.rules.filter((r) => rules.includes(r.id)) : ctx.rules;
    return picked.map((r) => `## ${r.id}: ${r.description}\n${r.hint}`).join('\n\n');
  },
});
