// Small AST helpers shared by the built-in rules. Not a plugin.
import { ts, walk } from '#harness/plugin-api.ts';

/** Climb past `await` and parentheses. */
export function outerExpression(n: ts.Node): ts.Node {
  let cur = n;
  while (cur.parent && (ts.isAwaitExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent))) cur = cur.parent;
  return cur;
}

/** The call that receives `n` as an argument, if any. */
export function enclosingCallArg(n: ts.Node): ts.CallExpression | null {
  const outer = outerExpression(n);
  const p = outer.parent;
  return p && ts.isCallExpression(p) && p.arguments.some((a) => a === outer) ? p : null;
}

export function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return null;
}

export function numericArg(call: ts.CallExpression, i: number): number | null {
  const a = call.arguments[i];
  return a && ts.isNumericLiteral(a) ? Number(a.text) : null;
}

export function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
  });
  return out;
}

export function hasNumericLiteral(root: ts.Node, value: number): boolean {
  let found = false;
  walk(root, (n) => {
    if (ts.isNumericLiteral(n) && Number(n.text) === value) found = true;
  });
  return found;
}

/** Every value a function can return: arrow expression body or `return` statements (not nested functions). */
export function returnedExpressions(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): ts.Expression[] {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    n.forEachChild(visit);
  };
  if (fn.body) visit(fn.body);
  return out;
}
