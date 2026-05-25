import { SearchApiInput, searchApi } from '../tools/searchApi.js';
import { DescribeSchemaInput, describeSchema } from '../tools/describeSchema.js';
import { ExecuteInput, execute } from '../tools/execute.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';
import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { Corpus } from '../search/corpus.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

export interface CatalogDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
  corpus: Corpus;
  regsMaxCallsPerExecute: number;
}

export function buildCatalog(deps: CatalogDeps): ToolDescriptor[] {
  const names = deps.sdk.registeredNames.join(', ');
  const namespaces = deps.sdk.registeredNames.map(n => `${n}.*`).join(', ');
  return [
    {
      name: 'search_api',
      description:
        `BM25 search over the API endpoints and curated field dictionary for all bound sources (${names}). Returns TypeScript signatures and examples for use in execute.`,
      inputSchema: zodToJsonSchema(SearchApiInput),
      handler: async (args) => searchApi(SearchApiInput.parse(args), deps.corpus),
    },
    {
      name: 'describe_schema',
      description:
        `Look up an endpoint or field by exact dotted id (path) or by namespace prefix. Use to drill into the bound source surfaces (${namespaces}).`,
      inputSchema: zodToJsonSchema(DescribeSchemaInput),
      handler: async (args) => describeSchema(DescribeSchemaInput.parse(args), deps.corpus.entries),
    },
    {
      name: 'execute',
      description:
        `Run TypeScript inside a sandbox (no net, fs, env, or subprocess). Globals: ${deps.sdk.registeredNames.join(', ')}. Return the awaited expression as the result.`,
      inputSchema: zodToJsonSchema(ExecuteInput),
      handler: async (args) => execute(ExecuteInput.parse(args), deps),
    },
  ];
}
