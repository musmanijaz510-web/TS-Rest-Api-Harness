// Standard 02: every non-2xx response is application/problem+json with type,
// title, status, detail and instance. No ad-hoc error shapes, no framework defaults.
import { ctxCalls, defineRule, lineOf, ts, walk, type Finding, type FunctionNode } from '#harness/plugin-api.ts';
import { callsNamed, calleeName, hasNumericLiteral, numericArg, returnedExpressions } from '../_shared/ast.ts';

const REQUIRED_KEYS = ['type', 'title', 'status', 'detail', 'instance'];

/** Violations inside one handler/app-hook body. */
function violations(fn: FunctionNode, ctxName: string, file: string): string[] {
  const sf = fn.getSourceFile();
  const out: string[] = [];
  for (const { method, call } of ctxCalls(fn, ctxName)) {
    const at = `${file}:${lineOf(sf, call)}`;
    const status = numericArg(call, method === 'status' ? 0 : 1);
    if ((method === 'json' || method === 'body' || method === 'status') && status !== null && status >= 300) {
      out.push(`${at} ${ctxName}.${method}(..., ${status}) is a non-2xx response outside problem()`);
    }
    if (['text', 'html', 'redirect', 'newResponse'].includes(method)) out.push(`${at} ${ctxName}.${method}() bypasses problem+json`);
    const first = call.arguments[0];
    if (method === 'json' && first) {
      walk(first, (n) => {
        if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'error') out.push(`${at} ad-hoc { error } shape`);
      });
    }
  }
  walk(fn, (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['Response', 'HTTPException'].includes(n.expression.text)) {
      out.push(`${file}:${lineOf(sf, n)} new ${n.expression.text}() bypasses problem()`);
    }
  });
  return out;
}

function returnsOnlyProblem(fn: FunctionNode): boolean {
  const rets = returnedExpressions(fn);
  return rets.length > 0 && rets.every((e) => ts.isCallExpression(e) && calleeName(e) === 'problem');
}

export default defineRule({
  id: 'problem-json',
  description: 'Every non-2xx response is RFC 7807 application/problem+json produced by problem(); app.notFound and app.onError return problem().',
  hint: [
    'Return errors with `return problem(c, 404, `User ${id} not found`)` (src/lib/problem.ts). Never c.json({ error }), c.text(), new Response(), or HTTPException.',
    'app.notFound and app.onError must exist and every return in them must be problem(...); onError must map validation failures to 422.',
    'The problem() helper must set Content-Type application/problem+json and fill type, title, status, detail, instance.',
  ].join('\n'),
  check(api) {
    const findings: Finding[] = [];
    const helperFile = api.sources.find((f) => f.sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'problem'));

    // The helper itself.
    if (!helperFile) {
      findings.push({ file: '(api)', ok: false, message: 'no top-level function problem() found' });
    } else {
      const fn = helperFile.sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'problem');
      const text = helperFile.text;
      const keys = new Set<string>();
      walk(helperFile.sf, (n) => {
        if (ts.isObjectLiteralExpression(n)) for (const p of n.properties) if (p.name && ts.isIdentifier(p.name)) keys.add(p.name.text);
      });
      const missing = REQUIRED_KEYS.filter((k) => !keys.has(k));
      const problems = [
        ...(text.includes('application/problem+json') ? [] : ['never sets application/problem+json']),
        ...(missing.length ? [`body is missing ${missing.join(', ')}`] : []),
      ];
      findings.push(
        problems.length
          ? { file: helperFile.path, line: fn ? lineOf(helperFile.sf, fn) : undefined, ok: false, message: `problem(): ${problems.join('; ')}` }
          : { file: helperFile.path, line: fn ? lineOf(helperFile.sf, fn) : undefined, ok: true },
      );
    }

    // App-level hooks: the framework's default 404/500 are not problem+json.
    for (const kind of ['notFound', 'onError'] as const) {
      const hooks = api.appHooks.filter((h) => h.kind === kind);
      if (hooks.length === 0) findings.push({ file: '(api)', ok: false, message: `app.${kind}() is not defined; the framework default response is not problem+json` });
      for (const h of hooks) {
        const errs: string[] = [];
        if (!h.fn || !h.ctxName) errs.push(`${kind} handler could not be resolved`);
        else {
          if (!returnsOnlyProblem(h.fn)) errs.push(`every return in ${kind} must be problem(...)`);
          if (kind === 'onError' && !hasNumericLiteral(h.fn, 422)) errs.push('onError never maps validation failures to 422');
          errs.push(...violations(h.fn, h.ctxName, h.file));
        }
        findings.push(errs.length ? { file: h.file, line: h.line, ok: false, message: errs.join('; ') } : { file: h.file, line: h.line, ok: true });
      }
    }

    // Route handlers: each problem() call is a passing error path; each bypass is a failure.
    for (const r of api.routes) {
      if (!r.handler || !r.ctxName) continue; // zod-boundary reports unresolved handlers
      const file = r.handlerFile?.path ?? r.file;
      const sf = r.handler.getSourceFile();
      const errs = violations(r.handler, r.ctxName, file);
      if (errs.length) findings.push({ file: r.file, line: r.line, ok: false, message: `${r.method.toUpperCase()} ${r.path ?? '?'}: ${errs.join('; ')}` });
      for (const call of callsNamed(r.handler, 'problem')) findings.push({ file, line: lineOf(sf, call), ok: true });
    }

    // Anywhere in source: thrown framework exceptions render as text/plain.
    for (const f of api.sources) {
      walk(f.sf, (n) => {
        if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'HTTPException') {
          findings.push({ file: f.path, line: lineOf(f.sf, n), ok: false, message: 'HTTPException renders a non-problem response; throw a domain error mapped in onError or return problem()' });
        }
      });
    }
    return { unit: 'error paths', findings };
  },
});
