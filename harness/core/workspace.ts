// Path safety: every path the model supplies is resolved here, once.
import { resolve, sep } from 'node:path';
import { toRel } from './api-model.ts';

/** Files the model may never write, regardless of scope. */
export const PROTECTED_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  '.gitignore',
  '.npmrc',
];

/**
 * Resolve a model-supplied path against the workspace. Returns the normalized
 * relative path, or an error string when the path escapes the workspace.
 */
export function resolveInWorkspace(workspace: string, p: string): { rel: string; abs: string } | { error: string } {
  if (!p || p.includes('\0')) return { error: 'empty or invalid path' };
  const abs = resolve(workspace, p);
  const root = resolve(workspace);
  if (abs !== root && !abs.startsWith(root + sep)) return { error: `path escapes the workspace: ${p}` };
  const rel = toRel(root, abs);
  if (rel.split('/').some((seg) => seg === 'node_modules' || seg === '.git')) {
    return { error: `path is inside node_modules or .git: ${p}` };
  }
  return { rel, abs };
}

/** Minimal glob: `**` = any depth, `*` = within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesScope(rel: string, scope: readonly string[]): boolean {
  return scope.some((g) => globToRegExp(g).test(rel));
}
