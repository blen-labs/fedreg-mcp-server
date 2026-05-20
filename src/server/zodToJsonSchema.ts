import { z } from 'zod';

/**
 * Minimal Zod -> JSON Schema converter sufficient for our three tool inputs.
 * Not a general implementation; intentionally tight to the surface we use.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries<z.ZodTypeAny>(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!(value as any).isOptional?.() && !(value._def?.typeName === 'ZodDefault')) {
          required.push(key);
        }
      }
      const out: Record<string, unknown> = { type: 'object', properties };
      if (required.length) out.required = required;
      out.additionalProperties = false;
      return out;
    }
    case 'ZodString':
      return { type: 'string', ...(def.description ? { description: def.description } : {}) };
    case 'ZodNumber':
      return { type: 'number', ...(def.description ? { description: def.description } : {}) };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    case 'ZodDefault':
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue() };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values };
    case 'ZodEffects':
      return zodToJsonSchema(def.schema);
    default:
      return {};
  }
}
