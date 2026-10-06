// Plugin discovery. Dropping a file into plugins/<kind>/ registers it; nothing in
// core names an individual tool, hook, rule or driver.
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Driver, DriverFactory, Hook, Rule, Tool } from './types.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PLUGIN_ROOT = join(REPO_ROOT, 'plugins');
export const DRIVER_DIR = join(REPO_ROOT, 'harness', 'drivers');

export type Registry = {
  tools: Map<string, Tool>;
  hooks: Hook[];
  /** Standards rules and ORM validators: both are Rules and both join the standards check. */
  rules: Rule[];
  /** Plugin file each entry came from, for `harness plugins`. */
  origins: Map<string, string>;
};

async function loadDir(dir: string): Promise<{ file: string; value: unknown }[]> {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
    .sort();
  const out: { file: string; value: unknown }[] = [];
  for (const f of files) {
    const abs = join(dir, f);
    const mod: { default?: unknown } = await import(pathToFileURL(abs).href);
    if (mod.default === undefined) throw new Error(`plugin ${abs} has no default export`);
    out.push({ file: abs, value: mod.default });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function assertTool(v: unknown, file: string): Tool {
  if (!isObj(v) || typeof v.name !== 'string' || typeof v.description !== 'string' || typeof v.run !== 'function' || !isObj(v.input)) {
    throw new Error(`tool plugin ${file} must default-export { name, description, input: ZodSchema, run }`);
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(v.name)) throw new Error(`tool plugin ${file}: name must match ^[a-z][a-z0-9_]*$`);
  return v as unknown as Tool;
}

function assertHook(v: unknown, file: string): Hook {
  if (!isObj(v) || typeof v.name !== 'string' || (v.event !== 'pre' && v.event !== 'post') || typeof v.run !== 'function') {
    throw new Error(`hook plugin ${file} must default-export { name, event: 'pre'|'post', run }`);
  }
  return v as unknown as Hook;
}

function assertRule(v: unknown, file: string): Rule {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.check !== 'function' || typeof v.hint !== 'string') {
    throw new Error(`rule plugin ${file} must default-export { id, description, hint, check }`);
  }
  return v as unknown as Rule;
}

export async function loadRegistry(pluginRoot: string = DEFAULT_PLUGIN_ROOT): Promise<Registry> {
  const reg: Registry = { tools: new Map(), hooks: [], rules: [], origins: new Map() };
  const claim = (key: string, file: string): void => {
    const prev = reg.origins.get(key);
    if (prev) throw new Error(`duplicate plugin ${key}: ${prev} and ${file}`);
    reg.origins.set(key, file);
  };

  for (const { file, value } of await loadDir(join(pluginRoot, 'tools'))) {
    const tool = assertTool(value, file);
    claim(`tool:${tool.name}`, file);
    reg.tools.set(tool.name, tool);
  }
  for (const { file, value } of await loadDir(join(pluginRoot, 'hooks'))) {
    const hook = assertHook(value, file);
    claim(`hook:${hook.name}`, file);
    reg.hooks.push(hook);
  }
  for (const kind of ['rules', 'validators']) {
    for (const { file, value } of await loadDir(join(pluginRoot, kind))) {
      const rule = assertRule(value, file);
      claim(`rule:${rule.id}`, file);
      reg.rules.push(rule);
    }
  }
  return reg;
}

export function driverNames(): string[] {
  if (!existsSync(DRIVER_DIR)) return [];
  return readdirSync(DRIVER_DIR)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

export async function loadDriver(name: string, env: NodeJS.ProcessEnv = process.env): Promise<Driver> {
  if (!/^[a-z0-9-]+$/.test(name) || !driverNames().includes(name)) {
    throw new Error(`unknown driver "${name}". Available: ${driverNames().join(', ') || '(none)'}`);
  }
  const mod: { default?: unknown } = await import(pathToFileURL(join(DRIVER_DIR, `${name}.ts`)).href);
  if (typeof mod.default !== 'function') throw new Error(`driver ${name} must default-export a factory (env) => Driver`);
  return (mod.default as DriverFactory)(env);
}
