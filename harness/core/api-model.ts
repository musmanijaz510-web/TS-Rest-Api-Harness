// A syntactic model of a Hono-style TypeScript API: files, routes, handlers and
// app-level error hooks. Rules and gates read this instead of re-parsing.
// Parsing is per-file (no type checker) so it is fast and deterministic.
import ts from 'typescript';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type SourceInfo = {
  /** Workspace-relative, forward slashes. */
  path: string;
  text: string;
  sf: ts.SourceFile;
  isTest: boolean;
};

export type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

export type Route = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** null when the path is not a string literal. */
  path: string | null;
  file: string;
  line: number;
  call: ts.CallExpression;
  /** Resolved handler function, or null if it could not be resolved. */
  handler: FunctionNode | null;
  handlerFile: SourceInfo | null;
  /** Name of the handler's context parameter (e.g. `c`). */
  ctxName: string | null;
};

export type AppHook = {
  kind: 'onError' | 'notFound';
  file: string;
  line: number;
  fn: FunctionNode | null;
  ctxName: string | null;
};

export type ApiModel = {
  root: string;
  files: SourceInfo[];
  /** Non-test files. */
  sources: SourceInfo[];
  routes: Route[];
  appHooks: AppHook[];
};

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) visit(abs);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(toRel(root, abs));
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

export const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');
export const isTestPath = (p: string): boolean => /\.test\.ts$/.test(p) || /(^|\/)tests?\//.test(p);

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function isFunctionNode(n: ts.Node | undefined): n is FunctionNode {
  return !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n));
}

export function stringValue(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

function paramName(fn: FunctionNode | null, index: number): string | null {
  const p = fn?.parameters[index];
  return p && ts.isIdentifier(p.name) ? p.name.text : null;
}

/**
 * Load the API at `root`. `overlay` replaces file contents (keyed by relative path)
 * without touching disk, which lets gates evaluate a proposed write before it lands.
 */
export function loadApi(root: string, overlay: ReadonlyMap<string, string> = new Map()): ApiModel {
  const paths = new Set(listTsFiles(root));
  for (const p of overlay.keys()) if (p.endsWith('.ts')) paths.add(p);

  const files: SourceInfo[] = [...paths].sort().map((path) => {
    const text = overlay.get(path) ?? readFileSync(join(root, path), 'utf8');
    return {
      path,
      text,
      sf: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      isTest: isTestPath(path),
    };
  });
  const sources = files.filter((f) => !f.isTest);

  // Index top-level named functions so `app.get('/x', listUsers)` resolves across files.
  const named = new Map<string, { fn: FunctionNode; file: SourceInfo }>();
  for (const file of sources) {
    for (const st of file.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) named.set(st.name.text, { fn: st, file });
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && isFunctionNode(d.initializer)) named.set(d.name.text, { fn: d.initializer, file });
        }
      }
    }
  }

  const routes: Route[] = [];
  const appHooks: AppHook[] = [];
  for (const file of sources) {
    walk(file.sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const name = n.expression.name.text;
      // Ignore c.req.* and similar request accessors.
      if (ts.isPropertyAccessExpression(n.expression.expression) && n.expression.expression.name.text === 'req') return;

      if ((name === 'onError' || name === 'notFound') && n.arguments.length === 1) {
        const fn = resolveFn(n.arguments[0], named);
        appHooks.push({
          kind: name,
          file: file.path,
          line: lineOf(file.sf, n),
          fn: fn?.fn ?? null,
          ctxName: paramName(fn?.fn ?? null, name === 'onError' ? 1 : 0),
        });
        return;
      }

      if (!METHODS.has(name) || n.arguments.length < 2) return;
      const path = stringValue(n.arguments[0]);
      const last = n.arguments[n.arguments.length - 1];
      if (path === null && !isFunctionNode(last)) return; // e.g. map.get(a, b): not a route
      const resolved = resolveFn(last, named);
      const handler = resolved?.fn ?? null;
      routes.push({
        method: name as Route['method'],
        path,
        file: file.path,
        line: lineOf(file.sf, n),
        call: n,
        handler,
        handlerFile: resolved ? (resolved.file ?? file) : null,
        ctxName: paramName(handler, 0),
      });
    });
  }

  return { root, files, sources, routes, appHooks };

  function resolveFn(
    arg: ts.Expression | undefined,
    index: Map<string, { fn: FunctionNode; file: SourceInfo }>,
  ): { fn: FunctionNode; file: SourceInfo | null } | null {
    if (!arg) return null;
    if (isFunctionNode(arg)) return { fn: arg, file: null };
    if (ts.isIdentifier(arg)) return index.get(arg.text) ?? null;
    return null;
  }
}

/** Calls of the form `<ctx>.<method>(...)` inside `fn`, e.g. `c.json(...)`. */
export function ctxCalls(fn: ts.Node, ctxName: string): { method: string; call: ts.CallExpression }[] {
  const out: { method: string; call: ts.CallExpression }[] = [];
  walk(fn, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === ctxName
    ) {
      out.push({ method: n.expression.name.text, call: n });
    }
  });
  return out;
}

/** Calls of the form `<ctx>.req.<method>(...)`, e.g. `c.req.json()`. */
export function reqCalls(fn: ts.Node, ctxName: string): { method: string; call: ts.CallExpression }[] {
  const out: { method: string; call: ts.CallExpression }[] = [];
  walk(fn, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const recv = n.expression.expression;
    if (
      ts.isPropertyAccessExpression(recv) &&
      recv.name.text === 'req' &&
      ts.isIdentifier(recv.expression) &&
      recv.expression.text === ctxName
    ) {
      out.push({ method: n.expression.name.text, call: n });
    }
  });
  return out;
}

/** The file that physically contains a route's handler (handlers may live in another file). */
export function handlerSource(api: ApiModel, route: Route): SourceInfo | undefined {
  return route.handlerFile ?? api.files.find((f) => f.path === route.file);
}
