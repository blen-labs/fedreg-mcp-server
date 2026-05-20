import type { AuthConfig } from './authz.js';

/**
 * OAuth 2.0 Protected Resource Metadata document per RFC 9728.
 *
 * `resource` is REQUIRED and MUST be the canonical URL of the protected resource
 * (the MCP endpoint, e.g. https://example.com/mcp).
 */
export function oauthProtectedResource(cfg: AuthConfig, resourceUrl: string) {
  return {
    resource: resourceUrl,
    authorization_servers: cfg.issuer ? [cfg.issuer] : [],
    bearer_methods_supported: ['header'],
    scopes_supported: cfg.scopes ?? [],
    resource_documentation: 'https://github.com/blencorp/fedreg-mcp-server#auth',
    resource_name: 'Federal Register & eCFR MCP Server',
  };
}
