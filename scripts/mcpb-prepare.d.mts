export interface McpbUserConfigField {
  type: 'string';
  title: string;
  description: string;
  sensitive?: boolean;
  required?: boolean;
}

export interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string; url?: string };
  server: {
    type: 'node';
    entry_point: string;
    mcp_config: { command: string; args: string[]; env: Record<string, string> };
  };
  user_config: Record<string, McpbUserConfigField>;
  compatibility: { platforms: string[]; runtimes: { node: string } };
  tools: Array<{ name: string; description: string }>;
  license: string;
}

export declare function buildManifest(pkg: { version: string; license?: string }): McpbManifest;
