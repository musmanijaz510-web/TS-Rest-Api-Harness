# API standards (as enforced)

Each standard is a rule plugin in `plugins/rules/`. `harness check --api <dir>` prints
one line per rule per file (`pass` / `fail file:line message` / `n/a`), a summary line
per rule, and a verdict. A mandatory rule that finds nothing to check reports
**UNPROVEN**, never pass. The verdict is `100%` only when every rule passes.

The checks are syntactic (TypeScript AST) plus a real `tsc` run. They assume the Hono
style the scaffold uses: routes registered as `app.<method>('/v1/...', handler)` with a
full string-literal path, and a context parameter (`c`).

| Rule | Standard | Unit | Fails when |
|---|---|---|---|
| `zod-boundary` | 01 Zod at every boundary | handlers | a `c.req.json/param/query/header/...` call is not passed straight into `parseRequest(...)` or `Schema.safeParse(...)`; a `:param` route never parses `c.req.param()`; POST/PUT/PATCH never parses the body; a collection GET never parses the query; a `c.json(x)` body is not `Schema.parse(...)`; `c.text`/`c.html`/`c.body(payload)` |
| `zod-infer` | 01 types inferred, not re-written | files | an `interface`, or a `type` alias that is an object shape, appears in source |
| `problem-json` | 02 RFC 7807 only | error paths | `c.json(..., >=300)`, `{ error }` bodies, `c.text/html/redirect`, `new Response`, `HTTPException`; `app.notFound`/`app.onError` missing or returning anything but `problem(...)`; `onError` with no 422 mapping; the `problem()` helper not setting `application/problem+json` with type, title, status, detail, instance |
| `tsc-strict` | 03 strict type safety | files | `tsc --noEmit --strict --noUncheckedIndexedAccess -p tsconfig.json` reports an error (flags forced on the command line) |
| `type-escapes` | 03 no escape hatches | files | `any`, non-null assertion `x!`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` (source and tests) |
| `rest-conventions` | 04 REST conventions | routes | path not `/v<N>/...`; static segment not lowercase kebab-case plural; param not `:camelCase`; POST not on a collection, without 201, with 200, or ignoring `Idempotency-Key`; DELETE without `c.body(null, 204)`; item route without a 404 path; collection GET without `nextCursor`/`paginate()`; status outside {200, 201, 204, 400, 401, 403, 404, 409, 412, 415, 422, 429, 500, 503} |

## Conventions the scaffold provides

- `src/lib/problem.ts` has `problem(c, status, detail)`, the only way to send a non-2xx response.
- `src/lib/validate.ts` has `parseRequest(schema, input)`. It throws `RequestValidationError`, which
  `onError` maps to 422. A response that fails its schema surfaces as 500, not 422.
- `src/lib/pagination.ts` has `PageQuerySchema` (`cursor`, `limit` 1..100, default 20),
  `pageSchema(item)` and `paginate(items, query)`.
- `src/lib/idempotency.ts` has `idempotencyKey(c)`, `recall()` and `remember()`. A repeated key with the
  same payload replays the stored response; a repeated key with a different payload is a 409.

A passing error response:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{"type":"https://api.sf/problems/validation","title":"Request failed validation","status":422,"detail":"email: Invalid email address","instance":"/v1/users"}
```
