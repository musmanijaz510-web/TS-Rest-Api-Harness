// Both adapters map the same neutral conversation; nothing provider-shaped leaks back out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../harness/drivers/claude.ts';
import * as openai from '../harness/drivers/openai.ts';
import { loadDriver } from '../harness/core/registry.ts';
import type { DriverRequest } from '../harness/core/types.ts';

const req: DriverRequest = {
  system: 'sys',
  maxOutputTokens: 100,
  tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  messages: [
    { role: 'user', text: 'go' },
    { role: 'assistant', text: 'reading', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }] },
    { role: 'tool', results: [{ id: 't1', name: 'read_file', content: 'x', isError: false }] },
    { role: 'user', text: 'Not finished' },
  ],
};

test('claude adapter: system top-level, tool_result + feedback merged into one user turn', () => {
  const body = claude.toWireRequest(req, 'm') as { system: string; messages: { role: string; content: { type: string }[] }[]; tools: { input_schema: unknown }[] };
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(body.messages[2]?.content.map((b) => b.type), ['tool_result', 'text']);
  assert.deepEqual(body.tools[0]?.input_schema, req.tools[0]?.parameters);
});

test('claude adapter: parses tool_use and counts cached input tokens', () => {
  const r = claude.fromWireResponse({
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'b.ts' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  });
  assert.deepEqual(r.toolCalls, [{ id: 'u1', name: 'read_file', args: { path: 'b.ts' } }]);
  assert.equal(r.usage.inputTokens, 13);
});

test('openai adapter: system message first, one tool message per result, function tools', () => {
  const body = openai.toWireRequest(req, 'm') as { messages: { role: string }[]; tools: { type: string; function: { parameters: unknown } }[] };
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(body.tools[0]?.type, 'function');
  assert.deepEqual(body.tools[0]?.function.parameters, req.tools[0]?.parameters);
});

test('openai adapter: parses tool calls; unparseable arguments become a validation error, not a crash', () => {
  const r = openai.fromWireResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }, { id: 'c2', function: { name: 'read_file', arguments: '{oops' } }] } }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  });
  assert.deepEqual(r.toolCalls[0], { id: 'c1', name: 'read_file', args: { path: 'a.ts' } });
  assert.ok(typeof r.toolCalls[1]?.args === 'object');
  assert.equal(r.usage.inputTokens, 7);
});

test('drivers read keys from the environment only and fail clearly without them', async () => {
  for (const name of ['claude', 'openai']) await assert.rejects(loadDriver(name, {}), /nor OPENROUTER_API_KEY is set/);
  await assert.rejects(loadDriver('../core/loop'), /unknown driver/);
});

test('OPENROUTER_API_KEY routes both drivers through OpenRouter in their own wire format', async () => {
  const env = { OPENROUTER_API_KEY: 'sk-or-k', ANTHROPIC_API_KEY: 'direct', OPENAI_API_KEY: 'direct' };
  assert.equal((await loadDriver('claude', env)).model, 'anthropic/claude-sonnet-5.5 via openrouter');
  assert.equal((await loadDriver('openai', env)).model, 'openai/gpt-5.5 via openrouter');
  assert.equal((await loadDriver('claude', { ANTHROPIC_API_KEY: 'direct' })).model, 'claude-sonnet-5-5 via direct');
  await assert.rejects(loadDriver('claude', { OPENROUTER_API_KEY: 'sk-or-k', HARNESS_CLAUDE_MODEL: 'claude-sonnet-5-5' }), /not an OpenRouter model id/);
  await assert.rejects(loadDriver('openai', { OPENROUTER_API_KEY: 'k-or-v1-truncated' }), /truncated paste/);
});

test('requests go to the right URL with the right auth', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const body = String(url).endsWith('/messages')
      ? { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }
      : { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    for (const name of ['claude', 'openai']) await (await loadDriver(name, { OPENROUTER_API_KEY: 'sk-or-key' })).complete(req);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen.map((s) => s.url), ['https://openrouter.ai/api/v1/messages', 'https://openrouter.ai/api/v1/chat/completions']);
  for (const s of seen) assert.equal(s.headers.authorization, 'Bearer sk-or-key');
});

test('both adapters flag replies cut off at the output limit', () => {
  assert.equal(claude.fromWireResponse({ stop_reason: 'max_tokens', content: [], usage: { input_tokens: 1, output_tokens: 1 } }).truncated, true);
  assert.equal(openai.fromWireResponse({ choices: [{ finish_reason: 'length', message: { content: null } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }).truncated, true);
  assert.equal(openai.fromWireResponse({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }).truncated, false);
});

test('an error inside a 200 body is retried, not parsed as a reply', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const body = calls === 1 ? { error: { code: 502, message: 'upstream hiccup' } } : { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const r = await (await loadDriver('claude', { OPENROUTER_API_KEY: 'sk-or-key' })).complete(req);
    assert.equal(r.text, 'ok');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('openai adapter echoes provider-opaque tool-call data back on the next turn', () => {
  const r = openai.fromWireResponse({
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' }, extra_content: { vendor: { signature: 'abc' } } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const body = openai.toWireRequest({ ...req, messages: [{ role: 'assistant', text: '', toolCalls: r.toolCalls }] }, 'm') as { messages: { tool_calls?: Record<string, unknown>[] }[] };
  assert.deepEqual(body.messages[1]?.tool_calls?.[0]?.extra_content, { vendor: { signature: 'abc' } });
});
