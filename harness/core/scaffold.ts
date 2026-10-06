// Deterministic greenfield scaffold: plumbing (problem+json, request parsing,
// pagination, idempotency, app shell) is written by code, not by the model.
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './registry.ts';

export const TEMPLATE_DIR = join(REPO_ROOT, 'harness', 'templates', 'greenfield');

export function scaffoldGreenfield(target: string, name: string): void {
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`refusing to scaffold into non-empty directory: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  cpSync(TEMPLATE_DIR, target, { recursive: true });
  const pkg = join(target, 'package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('__NAME__', name));
}
