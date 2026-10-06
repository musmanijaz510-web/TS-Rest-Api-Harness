// Standard 03 (escape hatches): no `any`, no non-null assertions, and no
// ts-ignore / ts-expect-error / ts-nocheck directives, in source or tests.
import { defineRule, lineOf, ts, walk, type Finding } from '#harness/plugin-api.ts';

const DIRECTIVE = /\/[/*]\s*@ts-(ignore|expect-error|nocheck)\b/;

export default defineRule({
  id: 'type-escapes',
  description: 'No any, no non-null assertions (x!), no @ts-ignore / @ts-expect-error / @ts-nocheck.',
  hint: 'Use unknown and narrow it, or derive the type from a Zod schema. Replace x! with an explicit undefined check that returns problem(c, 404, ...) or throws.',
  check(api) {
    const findings: Finding[] = [];
    for (const f of api.files) {
      const bad: string[] = [];
      walk(f.sf, (n) => {
        if (n.kind === ts.SyntaxKind.AnyKeyword) bad.push(`any at line ${lineOf(f.sf, n)}`);
        if (ts.isNonNullExpression(n)) bad.push(`non-null assertion at line ${lineOf(f.sf, n)}`);
      });
      f.text.split('\n').forEach((l, i) => {
        const m = DIRECTIVE.exec(l);
        if (m) bad.push(`@ts-${m[1] ?? ''} at line ${i + 1}`);
      });
      const firstLine = bad[0] ? Number(/line (\d+)/.exec(bad[0])?.[1]) : undefined;
      findings.push(bad.length ? { file: f.path, line: firstLine, ok: false, message: bad.join(', ') } : { file: f.path, ok: true });
    }
    return { unit: 'files', findings };
  },
});
