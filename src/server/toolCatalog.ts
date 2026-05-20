import { SearchApiInput, searchApi } from '../tools/searchApi.js';
import { DescribeSchemaInput, describeSchema } from '../tools/describeSchema.js';
import { ExecuteInput, execute } from '../tools/execute.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';
import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

export interface CatalogDeps {
  sdk: Sdk;
  sandbox: SandboxRunner;
}

export function buildCatalog(deps: CatalogDeps): ToolDescriptor[] {
  return [
    {
      name: 'search_api',
      description:
        'BM25 search over Federal Register and eCFR API endpoints and the curated field dictionary. Returns TypeScript signatures and examples for use in execute.',
      inputSchema: zodToJsonSchema(SearchApiInput),
      handler: async (args) => searchApi(SearchApiInput.parse(args)),
    },
    {
      name: 'describe_schema',
      description:
        'Look up an endpoint or field by exact dotted id (path) or by namespace prefix. Use to drill into fr.* and ecfr.* surfaces.',
      inputSchema: zodToJsonSchema(DescribeSchemaInput),
      handler: async (args) => describeSchema(DescribeSchemaInput.parse(args)),
    },
    {
      name: 'execute',
      description:
        'Run TypeScript inside a sandbox (no net, fs, env, or subprocess). Globals `fr` and `ecfr` proxy to FederalRegister.gov and eCFR. Return the awaited expression as the result.',
      inputSchema: zodToJsonSchema(ExecuteInput),
      handler: async (args) => execute(ExecuteInput.parse(args), deps),
    },
  ];
}
