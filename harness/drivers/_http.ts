// Shared HTTP for driver adapters: JSON POST with bounded retries on 429/5xx.
export async function postJson(url: string, headers: Record<string, string>, body: unknown, retries = 6): Promise<unknown> {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(60_000, 1000 * 2 ** attempt)));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      lastError = `network error: ${(err as Error).message}`;
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      const json: unknown = JSON.parse(text);
      // Gateways can report an upstream failure inside a 200 body; treat it as retryable.
      if (typeof json === 'object' && json !== null && 'error' in json && !('content' in json) && !('choices' in json)) {
        lastError = `upstream error in 200 response: ${JSON.stringify(json.error).slice(0, 500)}`;
        continue;
      }
      return json;
    }
    lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    if (res.status !== 429 && res.status < 500) break; // client errors do not get better by retrying
  }
  throw new Error(lastError);
}

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Where a driver sends its requests: the vendor's API, OpenRouter, or another gateway speaking the same wire format. */
export type Endpoint = { url: string; headers: Record<string, string>; model: string; via: string };

/** An extra gateway that accepts this driver's wire format (e.g. an OpenAI-compatible endpoint). */
export type Gateway = { keyVar: string; url: string; defaultModel: string };

type EndpointOptions = {
  keyVar: string;
  modelVar: string;
  /** Env var that picks the route explicitly: "direct", "openrouter", or a key of `gateways`. */
  viaVar: string;
  directModel: string;
  routerModel: string;
  directUrl: string;
  routerPath: string;
  directHeaders: (key: string) => Record<string, string>;
  gateways?: Record<string, Gateway>;
};

/**
 * Route selection: `<viaVar>` if set; otherwise OpenRouter when OPENROUTER_API_KEY is set
 * (one key for every driver); otherwise the vendor's own API. Keys come from the environment only.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, o: EndpointOptions): Endpoint {
  const routes = ['direct', 'openrouter', ...Object.keys(o.gateways ?? {})];
  const via = env[o.viaVar] ?? (env.OPENROUTER_API_KEY ? 'openrouter' : 'direct');
  if (!routes.includes(via)) throw new Error(`${o.viaVar}=${via} is not a route for this driver; use one of: ${routes.join(', ')}`);
  const model = env[o.modelVar];

  if (via === 'openrouter') {
    const routerKey = env.OPENROUTER_API_KEY;
    if (!routerKey) throw new Error(`${o.viaVar}=openrouter but OPENROUTER_API_KEY is not set`);
    if (!routerKey.startsWith('sk-or-')) {
      throw new Error(`OPENROUTER_API_KEY does not look like an OpenRouter key (expected it to start with "sk-or-"); check for a truncated paste`);
    }
    const m = model ?? o.routerModel;
    if (!m.includes('/')) throw new Error(`${o.modelVar}=${m} is not an OpenRouter model id; use vendor/model, e.g. ${o.routerModel}, or unset it`);
    return { url: `${env.OPENROUTER_BASE_URL ?? OPENROUTER_BASE}${o.routerPath}`, headers: { authorization: `Bearer ${routerKey}`, 'x-title': 'ts-api-harness' }, model: m, via };
  }

  const gateway = o.gateways?.[via];
  if (gateway) {
    const key = env[gateway.keyVar];
    if (!key) throw new Error(`${o.viaVar}=${via} but ${gateway.keyVar} is not set`);
    if (model?.includes('/')) throw new Error(`${o.modelVar}=${model} looks like an OpenRouter id; with ${o.viaVar}=${via} use e.g. ${gateway.defaultModel}, or unset it`);
    return { url: gateway.url, headers: { authorization: `Bearer ${key}` }, model: model ?? gateway.defaultModel, via };
  }

  const key = env[o.keyVar];
  if (!key) throw new Error(`neither ${o.keyVar} nor OPENROUTER_API_KEY is set. Provider keys come from the environment (or .env) only.`);
  return { url: o.directUrl, headers: o.directHeaders(key), model: model ?? o.directModel, via };
}
