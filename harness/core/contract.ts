// Contract surface: the routes an API exposes and the keys of its exported
// z.object schemas. Captured before a run; a change may add to it, never remove.
import ts from 'typescript';
import { walk, type ApiModel } from './api-model.ts';

export type Surface = {
  routes: string[];
  /** "file#ExportName" -> sorted keys */
  schemas: Record<string, string[]>;
};

export function surfaceOf(api: ApiModel): Surface {
  const routes = [
    ...new Set(api.routes.filter((r) => r.path !== null).map((r) => `${r.method.toUpperCase()} ${r.path}`)),
  ].sort();

  const schemas: Record<string, string[]> = {};
  for (const file of api.sources) {
    for (const st of file.sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const keys = objectSchemaKeys(d.initializer);
        if (keys) schemas[`${file.path}#${d.name.text}`] = keys;
      }
    }
  }
  return { routes, schemas };
}

/** Keys of the outermost `z.object({...})` in an initializer such as `z.object({...}).strict()`. */
function objectSchemaKeys(init: ts.Expression): string[] | null {
  let found: string[] | null = null;
  walk(init, (n) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'object' &&
      n.arguments[0] &&
      ts.isObjectLiteralExpression(n.arguments[0])
    ) {
      found = n.arguments[0].properties
        .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null))
        .filter((k): k is string => k !== null)
        .sort();
    }
  });
  return found;
}

/** Human-readable breaking changes from `before` to `after`. Empty = contract kept. */
export function breakingChanges(before: Surface, after: Surface): string[] {
  const out: string[] = [];
  const now = new Set(after.routes);
  for (const r of before.routes) if (!now.has(r)) out.push(`route removed: ${r}`);
  for (const [name, keys] of Object.entries(before.schemas)) {
    const next = after.schemas[name];
    if (!next) {
      out.push(`exported schema removed or renamed: ${name}`);
      continue;
    }
    const missing = keys.filter((k) => !next.includes(k));
    if (missing.length) out.push(`schema ${name} lost field(s): ${missing.join(', ')}`);
  }
  return out;
}
