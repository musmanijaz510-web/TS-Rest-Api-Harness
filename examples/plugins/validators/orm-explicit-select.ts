// Example ORM validator plugin. Install: cp examples/plugins/validators/orm-explicit-select.ts plugins/validators/
// Every Prisma or Drizzle query on users must select explicit columns.
import { defineRule, lineOf, ts, walk, type Finding } from '#harness/plugin-api.ts';

const PRISMA_READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow']);
const USERS = /^users?$/;

function objectHas(arg: ts.Expression | undefined, key: string): boolean {
  return !!arg && ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name?.getText() === key);
}

export default defineRule({
  id: 'orm-explicit-select',
  description: 'Prisma/Drizzle queries on users select explicit columns (no implicit SELECT *).',
  hint: 'Prisma: prisma.user.findMany({ select: { id: true, email: true } }). Drizzle: db.select({ id: users.id }).from(users) or db.query.users.findMany({ columns: { id: true } }).',
  optional: true, // an API without an ORM has nothing to check: n/a, not UNPROVEN
  check(api) {
    const findings: Finding[] = [];
    for (const f of api.sources) {
      walk(f.sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
        const method = n.expression.name.text;
        const recv = n.expression.expression;
        // prisma.user.findMany(...) / db.query.users.findMany(...)
        if (PRISMA_READS.has(method) && ts.isPropertyAccessExpression(recv) && USERS.test(recv.name.text)) {
          const key = ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === 'query' ? 'columns' : 'select';
          const ok = objectHas(n.arguments[0], key);
          findings.push({ file: f.path, line: lineOf(f.sf, n), ok, ...(ok ? {} : { message: `${recv.name.text}.${method}() without explicit ${key}` }) });
        }
        // db.select().from(users)
        if (method === 'from' && n.arguments[0] && ts.isIdentifier(n.arguments[0]) && USERS.test(n.arguments[0].text)) {
          if (ts.isCallExpression(recv) && ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === 'select') {
            const ok = recv.arguments.length > 0;
            findings.push({ file: f.path, line: lineOf(f.sf, n), ok, ...(ok ? {} : { message: 'select() without explicit columns on users' }) });
          }
        }
      });
    }
    return { unit: 'queries', findings };
  },
});
