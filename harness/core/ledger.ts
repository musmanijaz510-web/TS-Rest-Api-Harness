// Observed-red ledger. A test only counts as red when the harness's own runner
// saw it fail; the model's claims never reach this file.
import ts from 'typescript';
import { posix } from 'node:path';
import { isTestPath, type ApiModel } from './api-model.ts';

export type TestObservation = { file: string; ok: boolean; at: string };

export class RedLedger {
  readonly observations: TestObservation[] = [];
  readonly red = new Set<string>();

  record(file: string, ok: boolean): void {
    this.observations.push({ file, ok, at: new Date().toISOString() });
    if (!ok) this.red.add(file);
  }

  wasRed(file: string): boolean {
    return this.red.has(file);
  }

  toJSON(): { observations: TestObservation[]; red: string[] } {
    return { observations: this.observations, red: [...this.red].sort() };
  }
}

/** Relative module specifiers a file imports (static and dynamic). */
function importsOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      out.push(n.arguments[0].text);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out.filter((s) => s.startsWith('.'));
}

const stripExt = (p: string): string => p.replace(/\.(ts|js|mts|mjs)$/, '');

/**
 * Tests mapped to a source file. A test maps to a source when it imports it
 * directly, or when the test's stem (users.test.ts -> "users") equals the
 * source's file stem or one of its directory names (src/users/routes.ts).
 */
export function mappedTests(api: ApiModel, source: string): string[] {
  const target = stripExt(source);
  const segments = target.split('/');
  return api.files
    .filter((f) => f.isTest)
    .filter((t) => {
      const stem = posix.basename(t.path).replace(/\.test\.ts$/, '');
      if (segments.includes(stem)) return true;
      const dir = posix.dirname(t.path);
      return importsOf(t.sf).some((spec) => stripExt(posix.normalize(posix.join(dir, spec))) === target);
    })
    .map((t) => t.path);
}

/** Source files a write gate applies to: non-test TypeScript. */
export const isGatedSource = (p: string): boolean => p.endsWith('.ts') && !isTestPath(p);
