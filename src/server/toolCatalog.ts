import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { SearchApiInput, searchApi } from '../tools/searchApi.js';
import { DescribeSchemaInput, describeSchema } from '../tools/describeSchema.js';
import { ExecuteInput, execute, type RequestCtx } from '../tools/execute.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';
import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { Corpus } from '../search/corpus.js';
import type { SubjectQuota } from '../util/quotas.js';
import type { ExecutionLimiter } from '../util/executionLimiter.js';

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  /** JSON Schema of the structured result (`structuredContent`). */
  outputSchema: Record<string, unknown>;
  /** `signal` aborts when the client cancels the request or disconnects. */
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>;
  /** True when a returned result is a tool execution failure (MCP `isError`). */
  isFailure?: (result: unknown) => boolean;
}

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['endpoint', 'field'] }, binding: { type: 'string' },
    description: { type: 'string' }, signature: { type: 'string' }, example: { type: 'string' }, score: { type: 'number' },
  },
  required: ['id', 'kind', 'binding', 'description'],
} as const;

export const OUTPUT_SCHEMAS = {
  search_api: {
    type: 'object',
    properties: { hits: { type: 'array', items: ENTRY_SCHEMA }, note: { type: 'string' } },
    required: ['hits', 'note'],
  },
  describe_schema: {
    type: 'object',
    properties: { found: { type: 'boolean' }, entries: { type: 'array', items: ENTRY_SCHEMA }, message: { type: 'string' } },
    required: ['found'],
  },
  execute: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'false when the code threw, timed out, or broke a limit; see error' },
      value: { description: 'The JSON value the code returned' },
      logs: { type: 'array', items: { type: 'string' } },
      error: {
        type: 'object',
        properties: { name: { type: 'string' }, message: { type: 'string' }, status: { type: 'number' } },
        required: ['name', 'message'],
      },
      durationMs: { type: 'number' },
    },
    required: ['ok', 'logs', 'durationMs'],
  },
} as const;

export interface CatalogDeps {
  sdk: Sdk;
  sdkForSubject?: (subject?: string) => Promise<Sdk>;
  sandbox: SandboxRunner;
  corpus: Corpus;
  regsMaxCallsPerExecute: number;
  regsSubjectQuota?: SubjectQuota;
  publicMaxCallsPerExecute?: number;
  /** Caps simultaneous executions (global and per subject). */
  executionLimiter?: ExecutionLimiter;
  /** Aborts all executions on shutdown. */
  shutdownSignal?: AbortSignal;
}

export function buildCatalog(deps: CatalogDeps, requestCtx?: RequestCtx): ToolDescriptor[] {
  const names = deps.sdk.registeredNames.join(', ');
  const namespaces = deps.sdk.registeredNames.map(n => `${n}.*`).join(', ');
  return [
    {
      name: 'search_api',
      title: 'Search Regulatory API Documentation',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        `BM25 search over the API endpoints and curated field dictionary for all bound sources (${names}). Returns method signatures and JavaScript examples for use in execute.`,
      inputSchema: zodToJsonSchema(SearchApiInput),
      outputSchema: OUTPUT_SCHEMAS.search_api,
      handler: async (args) => searchApi(SearchApiInput.parse(args), deps.corpus),
    },
    {
      name: 'describe_schema',
      title: 'Describe Regulatory API Schema',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        `Look up an endpoint or field by exact dotted id (path) or by namespace prefix. Use to drill into the bound source surfaces (${namespaces}).`,
      inputSchema: zodToJsonSchema(DescribeSchemaInput),
      outputSchema: OUTPUT_SCHEMAS.describe_schema,
      handler: async (args) => describeSchema(DescribeSchemaInput.parse(args), deps.corpus.entries),
    },
    {
      name: 'execute',
      title: 'Query Federal Regulatory Data',
      // The sandbox SDK only reads upstream data. Idempotence describes external
      // effects, not identical results; annotations do not enforce permissions.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        `Run JavaScript inside a sandbox (no net, fs, env, or subprocess). Plain JS only — TypeScript type annotations are rejected. Globals: ${names}. Top-level await is allowed; \`return\` the value you want as the result.`,
      inputSchema: zodToJsonSchema(ExecuteInput),
      outputSchema: OUTPUT_SCHEMAS.execute,
      handler: async (args, ctx) => execute(ExecuteInput.parse(args), deps, { ...requestCtx, ...(ctx?.signal ? { signal: ctx.signal } : {}) }),
      isFailure: (result) => (result as { ok?: unknown })?.ok === false,
    },
  ];
}
