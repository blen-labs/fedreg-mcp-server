// Everything product-specific about this documentation site, in one place. The site is shared
// by BLEN's MCP servers: to reuse it, change this file and the pages in src/content/docs/.
// Read by astro.config.mjs, src/lib/install.ts and scripts/ (check-links, render-og,
// sync-reference).

export const productName = 'Federal Regulations MCP';
/** Where the hosted server serves this site (src/accounts/docs.ts serves it at `base`). */
export const site = 'https://fedreg.mcp.blenlabs.com';
export const base = '/docs';
export const repo = 'https://github.com/blen-labs/fedreg-mcp-server';
export const packageName = '@blen/fedreg-mcp-server';
/**
 * How people can run the server. `npm`: a published package that desktop clients start with npx
 * (the install buttons and pasted configs on the overview and connect pages). `mcpb`: a Claude
 * Desktop bundle attached to each GitHub release. A hosted-only server sets both to false: llms.txt
 * then omits the npm link, scripts/check-links.mjs skips the install checks, and its overview and
 * connect pages must not use the install helpers in src/lib/install.ts (they describe connecting
 * to the hosted URL only).
 */
export const distribution = { npm: true, mcpb: true };
/** The key a client config uses for this server (Cursor, VS Code, mcpServers). */
export const serverName = 'fedreg';
export const description =
  'Connect an AI assistant to the Federal Register, the eCFR, and regulations.gov with the Federal Regulations MCP server.';
/** The line under the name on the link-preview image, and its alt text. */
export const tagline = 'Ask your AI assistant about U.S. federal regulations.';
/** Environment variables a desktop install sets, with blank values (the server explains each). */
export const keyEnv = ['FEDREG_REGS_API_KEY'];
/** Example values shown in a pasted config. */
export const exampleKeyValues = { FEDREG_REGS_API_KEY: 'your-regulations-gov-key' };
/** What llms.txt says about the product, above the page list. */
export const llmsDetails = [
  'Run it on your own computer, or connect to the hosted server and sign in. The Federal Register and the eCFR need no key; regulations.gov needs your own free key.',
  'It has three tools: `search_api`, `describe_schema`, and `execute`.',
  'Each page below is also available on its own, as Markdown.',
].join('\n');
