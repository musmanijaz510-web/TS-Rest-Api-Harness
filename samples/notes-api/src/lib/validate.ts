// Request-boundary parsing. A failure here becomes a 422 problem in app.onError.
import { z } from 'zod';

export class RequestValidationError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'RequestValidationError';
    this.detail = detail;
  }
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`).join('; ');
}

/**
 * Parse untrusted request input: params, query, headers or body.
 * Pass c.req.json() directly; malformed JSON is reported as a validation failure.
 */
export async function parseRequest<S extends z.ZodType>(schema: S, input: unknown): Promise<z.output<S>> {
  let data: unknown;
  try {
    data = await input;
  } catch {
    throw new RequestValidationError('body: not valid JSON');
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new RequestValidationError(describeIssues(result.error));
  return result.data;
}
