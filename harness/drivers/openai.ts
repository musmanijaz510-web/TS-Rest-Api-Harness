// Driver adapter: OpenAI Chat Completions API. Everything vendor-specific about
// message shape, tool schema format and usage accounting stays in this file.
import { z } from 'zod';
import type { Driver, DriverFactory, DriverRequest, DriverResponse, Message } from '../core/types.ts';
import { postJson, resolveEndpoint } from './_http.ts';

const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.string().optional(),
                function: z.object({ name: z.string(), arguments: z.string() }),
                // Some compatible endpoints attach data that must be sent back unchanged on the next turn.
                extra_content: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

type WireMessage = Record<string, unknown>;

export function toWireMessages(system: string, messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
    else {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ ...c.meta, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
          : {}),
      });
    }
  }
  return out;
}

export function toWireRequest(req: DriverRequest, model: string): Record<string, unknown> {
  return {
    model,
    max_completion_tokens: req.maxOutputTokens,
    messages: toWireMessages(req.system, req.messages),
    tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
}

export function fromWireResponse(json: unknown): DriverResponse {
  const r = ResponseSchema.parse(json);
  const choice = r.choices[0];
  const msg = choice?.message;
  return {
    text: msg?.content ?? '',
    toolCalls: (msg?.tool_calls ?? []).map((c) => {
      let args: unknown;
      try {
        args = JSON.parse(c.function.arguments);
      } catch {
        args = { __unparseable_arguments: c.function.arguments.slice(0, 200) };
      }
      return { id: c.id, name: c.function.name, args, ...(c.extra_content ? { meta: { extra_content: c.extra_content } } : {}) };
    }),
    usage: { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens },
    truncated: choice?.finish_reason === 'length',
  };
}

const factory: DriverFactory = (env) => {
  // Resolved up front so a missing key fails before any work starts.
  const ep = resolveEndpoint(env, {
    keyVar: 'OPENAI_API_KEY',
    modelVar: 'HARNESS_OPENAI_MODEL',
    viaVar: 'HARNESS_OPENAI_VIA',
    directModel: 'gpt-5.5',
    routerModel: 'openai/gpt-5.5',
    directUrl: `${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`,
    routerPath: '/chat/completions',
    directHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    // Same Chat Completions wire format, different vendor: useful for low-cost testing.
    gateways: {
      gemini: { keyVar: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', defaultModel: 'gemini-3.5-flash' },
    },
  });
  const driver: Driver = {
    name: 'openai',
    model: `${ep.model} via ${ep.via}`,
    async complete(req) {
      return fromWireResponse(await postJson(ep.url, ep.headers, toWireRequest(req, ep.model)));
    },
  };
  return driver;
};
export default factory;
