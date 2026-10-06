// Example linter rule plugin. Install: cp examples/plugins/rules/no-console.ts plugins/rules/
// No console.* in API source (src/server.ts may log its listen address).
import { defineRule, lineOf, ts, walk, type Finding } from '#harness/plugin-api.ts';

export default defineRule({
  id: 'no-console',
  description: 'No console.* calls in API source except src/server.ts.',
  hint: 'Remove console.* from handlers and libraries; return problem() for errors instead of logging them.',
  check(api) {
    const findings: Finding[] = [];
    for (const f of api.sources) {
      if (f.path === 'src/server.ts') continue;
      const hits: number[] = [];
      walk(f.sf, (n) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'console') hits.push(lineOf(f.sf, n));
      });
      const first = hits[0];
      findings.push(first ? { file: f.path, line: first, ok: false, message: `console.* at line(s) ${hits.join(', ')}` } : { file: f.path, ok: true });
    }
    return { unit: 'files', findings };
  },
});
