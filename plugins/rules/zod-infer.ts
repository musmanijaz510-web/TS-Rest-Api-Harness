// Standard 01 (types): TypeScript types come from Zod schemas (z.infer/z.output),
// never hand-written a second time as interfaces or object type literals.
import { defineRule, lineOf, ts, walk, type Finding } from '#harness/plugin-api.ts';

function hasObjectLiteralType(t: ts.TypeNode): boolean {
  let found = false;
  walk(t, (n) => {
    // Object shapes inside generic constraints or z.infer<> arguments are fine; a type alias that *is* an object shape is not.
    if (ts.isTypeLiteralNode(n) && !ts.isTypeReferenceNode(n.parent) && !ts.isTypeParameterDeclaration(n.parent)) found = true;
  });
  return found;
}

export default defineRule({
  id: 'zod-infer',
  description: 'No interfaces or hand-written object types in source: derive types with z.infer / z.output from the schema.',
  hint: 'Replace `interface User {...}` or `type User = {...}` with `export type User = z.output<typeof UserSchema>`. Unions of inferred types are fine.',
  check(api) {
    const findings: Finding[] = [];
    for (const f of api.sources) {
      const bad: { line: number; name: string }[] = [];
      walk(f.sf, (n) => {
        if (ts.isInterfaceDeclaration(n)) bad.push({ line: lineOf(f.sf, n), name: `interface ${n.name.text}` });
        if (ts.isTypeAliasDeclaration(n) && hasObjectLiteralType(n.type)) bad.push({ line: lineOf(f.sf, n), name: `type ${n.name.text}` });
      });
      const first = bad[0];
      findings.push(first ? { file: f.path, line: first.line, ok: false, message: `hand-written type(s): ${bad.map((b) => `${b.name} (line ${b.line})`).join(', ')}` } : { file: f.path, ok: true });
    }
    return { unit: 'files', findings };
  },
});
