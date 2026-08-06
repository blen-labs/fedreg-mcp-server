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
    mcp_config: { command: string; args: string[] };
  };
}

export declare function buildManifest(pkg: { version: string }): McpbManifest;
