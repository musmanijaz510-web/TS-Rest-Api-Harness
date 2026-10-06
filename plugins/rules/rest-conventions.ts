// Standard 04: plural nouns, versioned base path, cursor pagination, idempotency
// keys on POST, and consistent 201 / 204 / 404 / 409 / 422.
import { ctxCalls, defineRule, ts, walk, type Finding, type Route } from '#harness/plugin-api.ts';
import { callsNamed, hasNumericLiteral, numericArg } from '../_shared/ast.ts';

const ALLOWED_STATUS = new Set([200, 201, 204, 400, 401, 403, 404, 409, 412, 415, 422, 429, 500, 503]);
const IRREGULAR_PLURALS = new Set(['people', 'children', 'data', 'media', 'news', 'series', 'feedback', 'metadata']);
const isPlural = (s: string): boolean => IRREGULAR_PLURALS.has(s) || (s.endsWith('s') && !s.endsWith('ss'));

function statusesUsed(r: Route): number[] {
  if (!r.handler || !r.ctxName) return [];
  const out: number[] = [];
  for (const { method, call } of ctxCalls(r.handler, r.ctxName)) {
    const s = numericArg(call, method === 'status' ? 0 : 1);
    if (s !== null) out.push(s);
  }
  for (const call of callsNamed(r.handler, 'problem')) {
    const s = numericArg(call, 1);
    if (s !== null) out.push(s);
  }
  return out;
}

function mentions(fn: ts.Node, pattern: RegExp): boolean {
  let found = false;
  walk(fn, (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isIdentifier(n)) && pattern.test(n.text)) found = true;
  });
  return found;
}

export default defineRule({
  id: 'rest-conventions',
  description: 'Versioned plural-noun paths, cursor-paginated collections, Idempotency-Key on POST, 201 on create, 204 on delete, 404 on missing items.',
  hint: [
    'Paths are string literals like /v1/users and /v1/users/:id; static segments are lowercase kebab-case plural nouns.',
    'Collection GET: parse { cursor, limit } (PageQuerySchema) and return { data, nextCursor } (use paginate() and pageSchema()).',
    'POST targets a collection, reads the Idempotency-Key header (idempotencyKey(c), recall/remember from src/lib/idempotency.ts) and returns 201.',
    'GET/PUT/PATCH/DELETE on /:id return problem(c, 404, ...) when the item is missing. DELETE returns c.body(null, 204).',
    'Conflicts (duplicate unique field) are 409; validation failures are 422. Allowed statuses: 200 201 204 400 401 403 404 409 412 415 422 429 500 503.',
  ].join('\n'),
  check(api) {
    const findings: Finding[] = [];
    for (const r of api.routes) {
      const at = { file: r.file, line: r.line };
      const label = `${r.method.toUpperCase()} ${r.path ?? '<non-literal path>'}`;
      const errs: string[] = [];
      if (r.path === null) {
        findings.push({ ...at, ok: false, message: `${label}: register routes with a full string-literal path` });
        continue;
      }
      const segs = r.path.split('/').filter(Boolean);
      if (!/^v\d+$/.test(segs[0] ?? '')) errs.push('path must start with a version segment like /v1');
      if (r.path.endsWith('/') && r.path !== '/') errs.push('no trailing slash');
      const rest = segs.slice(1);
      if (rest.length === 0) errs.push('no resource after the version segment');
      for (const s of rest) {
        if (s.startsWith(':')) {
          if (!/^:[a-z][a-zA-Z0-9]*$/.test(s)) errs.push(`param ${s} must be :camelCase`);
        } else if (!/^[a-z][a-z0-9-]*$/.test(s)) errs.push(`segment "${s}" must be lowercase kebab-case`);
        else if (!isPlural(s)) errs.push(`segment "${s}" must be a plural noun`);
      }
      const isItem = (rest[rest.length - 1] ?? '').startsWith(':');
      const fn = r.handler;
      if (fn && r.ctxName) {
        const statuses = statusesUsed(r);
        for (const s of statuses) if (!ALLOWED_STATUS.has(s)) errs.push(`status ${s} is not in the allowed set`);
        if (r.method === 'post') {
          if (isItem) errs.push('POST must target a collection, not an item');
          if (!statuses.includes(201)) errs.push('POST create must respond 201');
          if (statuses.includes(200)) errs.push('POST create must not respond 200');
          if (!mentions(fn, /^idempotency-key$/i) && callsNamed(fn, 'idempotencyKey').length === 0) errs.push('POST must honour the Idempotency-Key header');
        }
        if (r.method === 'delete') {
          if (!isItem) errs.push('DELETE must target an item (/:id)');
          const has204 = ctxCalls(fn, r.ctxName).some((c) => c.method === 'body' && numericArg(c.call, 1) === 204);
          if (!has204) errs.push('DELETE must respond c.body(null, 204)');
        }
        if (isItem && !hasNumericLiteral(fn, 404)) errs.push('item route must return 404 when the item does not exist');
        if (r.method === 'get' && !isItem && !mentions(fn, /^nextCursor$/) && callsNamed(fn, 'paginate').length === 0) errs.push('collection GET must be cursor-paginated ({ data, nextCursor })');
        if ((r.method === 'put' || r.method === 'patch') && !isItem) errs.push(`${r.method.toUpperCase()} must target an item (/:id)`);
      }
      findings.push(errs.length ? { ...at, ok: false, message: `${label}: ${errs.join('; ')}` } : { ...at, ok: true });
    }
    return { unit: 'routes', findings };
  },
});
