import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { idempotencyKey, recall, remember } from './lib/idempotency.ts';
import { pageSchema, paginate, PageQuerySchema } from './lib/pagination.ts';
import { problem } from './lib/problem.ts';
import { parseRequest } from './lib/validate.ts';

export const UserRoleSchema = z.enum(['admin', 'member']);

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(120),
  role: UserRoleSchema.default('member'),
  createdAt: z.iso.datetime(),
});

export type User = z.output<typeof UserSchema>;

const CreateUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(120),
  role: UserRoleSchema.default('member'),
});

type CreateUser = z.output<typeof CreateUserSchema>;

const PatchUserSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    role: UserRoleSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.role !== undefined, '(root): provide at least one field to update');

type PatchUser = z.output<typeof PatchUserSchema>;

const UserIdParamsSchema = z.object({ id: z.uuid() });
const UserPageSchema = pageSchema(UserSchema);

const users = new Map<string, User>();

function allUsers(): User[] {
  return [...users.values()];
}

function findUser(id: string): User | undefined {
  return users.get(id);
}

function emailTaken(email: string): boolean {
  return allUsers().some((user) => user.email === email);
}

function createUser(input: CreateUser): User {
  return UserSchema.parse({
    id: randomUUID(),
    email: input.email,
    name: input.name,
    role: input.role,
    createdAt: new Date().toISOString(),
  });
}

function applyPatch(user: User, patch: PatchUser): User {
  return UserSchema.parse({
    ...user,
    name: patch.name ?? user.name,
    role: patch.role ?? user.role,
  });
}

export function registerUserRoutes(app: Hono): void {
  app.get('/v1/users', async (c) => {
    const query = await parseRequest(PageQuerySchema, c.req.query());
    return c.json(UserPageSchema.parse(paginate(allUsers(), query)));
  });

  app.post('/v1/users', async (c) => {
    const body = await parseRequest(CreateUserSchema, c.req.json());
    const key = await idempotencyKey(c);
    const replay = recall('POST /v1/users', key, body);
    if (replay !== undefined) return c.json(UserSchema.parse(replay), 201);

    if (emailTaken(body.email)) return problem(c, 409, `Email ${body.email} is already taken`);

    const user = createUser(body);
    users.set(user.id, user);
    const responseBody = UserSchema.parse(user);
    remember('POST /v1/users', key, body, responseBody);
    return c.json(UserSchema.parse(responseBody), 201);
  });

  app.get('/v1/users/:id', async (c) => {
    const { id } = await parseRequest(UserIdParamsSchema, c.req.param());
    const user = findUser(id);
    if (user === undefined) return problem(c, 404, `User ${id} not found`);
    return c.json(UserSchema.parse(user));
  });

  app.patch('/v1/users/:id', async (c) => {
    const { id } = await parseRequest(UserIdParamsSchema, c.req.param());
    const body = await parseRequest(PatchUserSchema, c.req.json());
    const existing = findUser(id);
    if (existing === undefined) return problem(c, 404, `User ${id} not found`);

    const updated = applyPatch(existing, body);
    users.set(id, updated);
    return c.json(UserSchema.parse(updated));
  });

  app.delete('/v1/users/:id', async (c) => {
    const { id } = await parseRequest(UserIdParamsSchema, c.req.param());
    if (!users.has(id)) return problem(c, 404, `User ${id} not found`);
    users.delete(id);
    return c.body(null, 204);
  });
}
