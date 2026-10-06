// Standard 01 (boundaries): every request input is parsed by Zod into a 422 on
// failure, and every JSON response body is produced by Schema.parse().
import { ctxCalls, defineRule, lineOf, reqCalls, ts, type Finding } from '#harness/plugin-api.ts';
import { calleeName, enclosingCallArg } from '../_shared/ast.ts';

const INPUTS = new Set(['json', 'param', 'query', 'queries', 'header', 'parseBody', 'formData', 'text', 'arrayBuffer', 'blob']);
const REQUEST_PARSERS = new Set(['parseRequest', 'safeParse', 'safeParseAsync']);

export default defineRule({
  id: 'zod-boundary',
  description: 'Request params, query, headers and body are parsed with Zod; every JSON response body is Schema.parse(...).',
  hint: [
    'Inputs: wrap every c.req.* accessor directly: `const body = await parseRequest(CreateUserSchema, c.req.json())`,',
    '`const { id } = await parseRequest(IdParamsSchema, c.req.param())`, `const q = await parseRequest(ListQuerySchema, c.req.query())`.',
    'parseRequest (src/lib/validate.ts) turns failures into a 422 problem. Schema.safeParse(c.req...) is also accepted; bare .parse() on input is not (it would surface as 500).',
    'Routes with :params must parse c.req.param(); POST/PUT/PATCH must parse c.req.json(); collection GETs must parse c.req.query().',
    'Outputs: `return c.json(UserSchema.parse(user), 201)`. The first argument of c.json is always a Schema.parse(...) call. 204: `c.body(null, 204)`.',
    'Handlers must be inline functions or named functions declared at top level so the harness can find them.',
  ].join('\n'),
  check(api) {
    const findings: Finding[] = [];
    for (const r of api.routes) {
      const at = { file: r.file, line: r.line };
      if (!r.handler || !r.ctxName) {
        findings.push({ ...at, ok: false, message: `${r.method.toUpperCase()} ${r.path ?? '?'}: handler could not be resolved (define it inline or as a top-level named function)` });
        continue;
      }
      const sf = r.handler.getSourceFile();
      const handlerFile = r.handlerFile?.path ?? r.file;
      const problems: string[] = [];
      const inputs = reqCalls(r.handler, r.ctxName).filter((c) => INPUTS.has(c.method));
      for (const { method, call } of inputs) {
        const parent = enclosingCallArg(call);
        const parser = parent ? calleeName(parent) : null;
        if (!parser || !REQUEST_PARSERS.has(parser)) {
          problems.push(`${handlerFile}:${lineOf(sf, call)} ${r.ctxName}.req.${method}() is not passed straight into parseRequest/safeParse`);
        }
      }
      const used = new Set(inputs.map((c) => c.method));
      if (r.path?.includes('/:') && !used.has('param')) problems.push('path has :params but c.req.param() is never parsed');
      if (['post', 'put', 'patch'].includes(r.method) && !used.has('json') && !used.has('parseBody')) problems.push(`${r.method.toUpperCase()} never parses the request body`);
      const lastSeg = r.path?.split('/').pop() ?? '';
      if (r.method === 'get' && r.path && !lastSeg.startsWith(':') && !used.has('query')) problems.push('collection GET never parses c.req.query()');

      for (const { method, call } of ctxCalls(r.handler, r.ctxName)) {
        const line = lineOf(sf, call);
        if (method === 'json') {
          const first = call.arguments[0];
          const ok = first && ts.isCallExpression(first) && ts.isPropertyAccessExpression(first.expression) && first.expression.name.text === 'parse';
          if (!ok) problems.push(`${handlerFile}:${line} c.json() body is not Schema.parse(...)`);
        }
        if (method === 'body' && call.arguments[0]?.kind !== ts.SyntaxKind.NullKeyword) problems.push(`${handlerFile}:${line} c.body() with a payload bypasses response schemas`);
        if (method === 'text' || method === 'html') problems.push(`${handlerFile}:${line} c.${method}() response is not schema-validated JSON`);
      }
      findings.push(problems.length ? { ...at, ok: false, message: `${r.method.toUpperCase()} ${r.path ?? '?'}: ${problems.join('; ')}` } : { ...at, ok: true });
    }
    return { unit: 'handlers', findings };
  },
});
