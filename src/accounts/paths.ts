/**
 * Account mode serves two MCP endpoints on one origin. MCP clients only start OAuth when an
 * endpoint answers 401, so anonymous and signed-in access need separate URLs:
 * - PUBLIC_MCP_PATH: no sign-in. Federal Register and eCFR; regulations.gov only through the
 *   operator's shared key, if one is configured.
 * - ACCOUNT_MCP_PATH: OAuth (Google sign-in). Adds regulations.gov with the user's own key.
 */
export const PUBLIC_MCP_PATH = '/mcp';
export const ACCOUNT_MCP_PATH = '/mcp/account';
