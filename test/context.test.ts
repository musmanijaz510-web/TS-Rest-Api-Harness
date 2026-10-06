import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../harness/core/context.ts';
import { loadRegistry } from '../harness/core/registry.ts';
import type { Message, ToolCall } from '../harness/core/types.ts';

const registry = await loadRegistry();
const keyOf = (c: ToolCall): string | undefined => {
  const t = registry.tools.get(c.name);
  const p = t?.input.safeParse(c.args);
  return t?.contextKey && p?.success ? t.contextKey(p.data) : undefined;
};

/** One tool call per turn, the way a model working file by file behaves. */
function history(steps: { name: string; args: Record<string, unknown>; out: string }[]): Message[] {
  const msgs: Message[] = [{ role: 'user', text: 'go' }];
  steps.forEach((s, i) => {
    msgs.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: s.name, args: s.args }] });
    msgs.push({ role: 'tool', results: [{ id: `c${i}`, name: s.name, content: s.out, isError: false }] });
  });
  return msgs;
}
const body = (tag: string): string => `${tag}\n${'x'.repeat(2000)}`;
const contentOf = (msgs: Message[], id: string): string =>
  msgs.flatMap((m) => (m.role === 'tool' ? m.results : [])).find((r) => r.id === id)?.content ?? '';

test('reading many files one per turn keeps every one of them (no forget/re-read thrash)', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'test/a.test.ts'];
  const out = compactHistory(history(files.map((p) => ({ name: 'read_file', args: { path: p }, out: body(p) }))), keyOf);
  files.forEach((_, i) => assert.doesNotMatch(contentOf(out, `c${i}`), /compacted/, files[i]));
});

test('a re-read or a write of the same file makes the older content stale', () => {
  const out = compactHistory(
    history([
      { name: 'read_file', args: { path: 'src/a.ts' }, out: body('a-v1') },
      { name: 'read_file', args: { path: 'src/a.ts', startLine: 1, endLine: 40 }, out: body('a-part') },
      { name: 'write_file', args: { path: './src/a.ts', content: 'y'.repeat(900) }, out: 'wrote src/a.ts' },
      { name: 'read_file', args: { path: 'src/b.ts' }, out: body('b') },
      { name: 'run_tests', args: {}, out: body('tests-1') },
      { name: 'run_tests', args: {}, out: body('tests-2') },
      { name: 'read_file', args: { path: 'src/c.ts' }, out: body('c') },
      { name: 'read_file', args: { path: 'src/d.ts' }, out: body('d') },
    ]),
    keyOf,
  );
  assert.match(contentOf(out, 'c0'), /superseded/); // full read, superseded by the write
  assert.match(contentOf(out, 'c1'), /superseded/); // ranged read, a part of the same file
  assert.doesNotMatch(contentOf(out, 'c3'), /superseded/); // b.ts is still live
  assert.match(contentOf(out, 'c4'), /superseded/); // older test run
  assert.doesNotMatch(contentOf(out, 'c5'), /superseded/); // latest test run
  const write = out.find((m) => m.role === 'assistant' && m.toolCalls[0]?.id === 'c2');
  assert.equal(write?.role === 'assistant' ? (write.toolCalls[0]?.args as { content: string }).content.length : 0, 900); // what it wrote stays visible
});

test('the budget still caps live context, oldest first, newest always verbatim', () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ name: 'read_file', args: { path: `src/f${i}.ts` }, out: body(`f${i}`) }));
  const out = compactHistory(history(steps), keyOf, 10_000);
  assert.match(contentOf(out, 'c0'), /compacted/);
  assert.doesNotMatch(contentOf(out, 'c11'), /compacted/);
  assert.doesNotMatch(contentOf(out, 'c10'), /compacted/);
});
