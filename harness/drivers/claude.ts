// Driver adapter: Anthropic Messages API. Everything vendor-specific about
// message shape, tool schema format and usage accounting stays in this file.
import { z } from 'zod';
import type { Driver, DriverFactory, DriverRequest, DriverResponse, Message } from '../core/types.ts';
import { postJson, resolveEndpoint } from './_http.ts';

const ResponseSchema = z.object({
  stop_reason: z.string().nullish(),
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
      z.object({ type: z.string() }).loose(),
    ]),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

type Block = Record<string, unknown>;
type WireMessage = { role: 'user' | 'assistant'; content: Block[] };

export function toWireMessages(messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text }]);
    else if (m.role === 'tool') {
      push('user', m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })));
    } else {
      const blocks: Block[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no output)' }]);
    }
  }
  return out;
}

export function toWireRequest(req: DriverRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: toWireMessages(req.messages),
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  };
}

export function fromWireResponse(json: unknown): DriverResponse {
  const r = ResponseSchema.parse(json);
  const text: string[] = [];
  const toolCalls: DriverResponse['toolCalls'] = [];
  for (const b of r.content) {
    if (b.type === 'text' && 'text' in b && typeof b.text === 'string') text.push(b.text);
    if (b.type === 'tool_use' && 'id' in b && typeof b.id === 'string' && 'name' in b && typeof b.name === 'string') {
      toolCalls.push({ id: b.id, name: b.name, args: 'input' in b ? b.input : {} });
    }
  }
  const u = r.usage;
  return {
    text: text.join('\n'),
    toolCalls,
    truncated: r.stop_reason === 'max_tokens',
    usage: {
      // Count every input token the request occupied, cached or not: this is a context-footprint metric.
      inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    },
  };
}

const factory: DriverFactory = (env) => {
  // Resolved up front so a missing key fails before any work starts.
  const ep = resolveEndpoint(env, {
    keyVar: 'ANTHROPIC_API_KEY',
    modelVar: 'HARNESS_CLAUDE_MODEL',
    viaVar: 'HARNESS_CLAUDE_VIA',
    directModel: 'claude-sonnet-5-5',
    routerModel: 'anthropic/claude-sonnet-5.5',
    directUrl: `${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`,
    routerPath: '/messages', // OpenRouter's Anthropic-compatible endpoint: same wire format
    directHeaders: (key) => ({ 'x-api-key': key }),
  });
  const driver: Driver = {
    name: 'claude',
    model: `${ep.model} via ${ep.via}`,
    async complete(req) {
      const json = await postJson(ep.url, { ...ep.headers, 'anthropic-version': '2023-06-01' }, toWireRequest(req, ep.model));
      return fromWireResponse(json);
    },
  };
  return driver;
};
export default factory;
