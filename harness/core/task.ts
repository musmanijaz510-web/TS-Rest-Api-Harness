// Task files are provider-neutral JSON. Unknown fields are kept and shown to the
// model verbatim, so a task written in a slightly different shape still runs.
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';

const FORBIDDEN_KEYS = ['model', 'provider', 'driver', 'vendor', 'temperature'];

const FieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
  })
  .loose();

export const TaskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
    kind: z.enum(['greenfield', 'brownfield']),
    /** Directory of the API, relative to the task file's repo root (cwd). */
    target: z.string().min(1),
    description: z.string().min(1),
    resource: z
      .object({ name: z.string().min(1), fields: z.array(FieldSchema).default([]) })
      .loose()
      .optional(),
    behaviours: z.array(z.string()).default([]),
    /** Workspace-relative globs the model may write. */
    scope: z.array(z.string()).default(['src/**', 'test/**']),
  })
  .loose();

export type Task = z.infer<typeof TaskSchema> & { source: string };

export function loadTask(file: string, cwd: string = process.cwd()): Task {
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new Error(`task file not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`task file is not valid JSON: ${file}: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`task file must be a JSON object: ${file}`);
  }
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  // Model agnosticism: a task may not choose or mention its model.
  const leaked = Object.keys(obj).filter((k) => FORBIDDEN_KEYS.includes(k.toLowerCase()));
  if (leaked.length) throw new Error(`task file must not set ${leaked.join(', ')}: the driver is a CLI choice`);

  // Lenient defaults so a differently-shaped task still loads.
  obj.id ??= basename(abs).replace(/\.task\.json$|\.json$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  obj.kind ??= obj.repo || obj.target ? 'brownfield' : 'greenfield';
  obj.target ??= obj.repo ?? `generated/${String(obj.id)}`;
  obj.description ??= obj.change ?? obj.summary ?? obj.goal;

  const parsed = TaskSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid task file ${file}: ${issues}`);
  }
  return { ...parsed.data, source: abs };
}

/** Repo root for resolving `target`: the directory the harness was invoked from. */
export function taskTarget(task: Task, cwd: string = process.cwd()): string {
  return resolve(cwd, task.target);
}
