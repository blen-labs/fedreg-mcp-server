import { z } from 'zod';

/**
 * Tool input schema as advertised in tools/list, from Zod 4's official converter so the
 * constraints the handler enforces (integer, min/max, length) are the ones clients see. Input
 * mode: fields with defaults are optional. Unknown keys are rejected.
 */
export function zodToJsonSchema(schema: z.ZodType, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  if (out.type === 'object') out.additionalProperties = false;
  return { ...out, ...extra };
}
