# Privacy Policy — Federal Register & eCFR Explorer (by BLEN)

_Last updated: 2026-09-22_

This policy describes how **Federal Register & eCFR Explorer**, powered by
`@blen/fedreg-mcp-server` (the "Service", operated by BLEN, Inc.), handles data
when accessed from Gemini Enterprise or another MCP client.

The BLEN-hosted endpoint at `https://fedreg.mcp.blenlabs.com/mcp` provides
public, unauthenticated, read-only access to Federal Register and eCFR data.
The software also supports regulations.gov, which requires a server-side API
key and is not available on deployments where that source is disabled.

## What the public Service receives

- **Tool arguments and results:** search terms, schema lookup paths, and plain
  JavaScript submitted to `execute`, along with data retrieved or computed to
  answer those calls. The connector receives tool requests, not an automatic
  copy of your entire conversation. Your MCP client determines what it sends.
- **Network metadata:** our hosting provider, Railway, handles connection
  metadata and request headers. The application uses the network peer IP
  address visible to it for in-memory rate limiting; behind a proxy, this may
  be the proxy address rather than your original IP address.
- **Support communications:** information you voluntarily provide when
  contacting BLEN for assistance.

No account, login, or personal profile is required for the public endpoint.
However, tool arguments, submitted code, headers, or support messages can
contain personal information if you or your client include it. Do not submit
passwords, API keys, confidential records, or sensitive personal information.

## What is sent to other services

`search_api` and `describe_schema` search bundled documentation locally.
`execute` can call the supported public APIs at FederalRegister.gov and
eCFR.gov, and regulations.gov when enabled. Those API requests include the
query terms, identifiers, and filters needed for your request. The complete
JavaScript body is executed on our server, not sent to those APIs.

The application does not intentionally forward your inbound IP address,
authorization header, or MCP-client identity to the government APIs.
Outbound connections use the hosting provider's network address and the
server's configured User-Agent. If regulations.gov is enabled, the server
sends its own API key to that provider; users do not need to supply it.

Results return to your MCP client. That client's storage, AI processing, and
privacy practices are governed by its own policies. Hosting and upstream API
providers also process requests under their applicable policies. We may
disclose information where required by law or necessary to address abuse or
protect the Service.

## Storage and retention

- **Execution:** the application has no database or file-storage feature for
  saving submitted code, conversation histories, or tool results. Execution
  occurs in a sandbox. This does not mean that every request fragment is
  excluded from operational logs.
- **Response cache:** upstream GET responses and their request URLs are
  cached in process memory. The default cache has a five-minute freshness
  period and a maximum of 2,000 entries per source client; operators can
  configure these values or disable caching. It is shared across calls, not
  tied to a user session. Stale entries may remain in memory until purged,
  evicted, or the process exits. The application does not persist this cache
  to disk.
- **Rate-limit state:** peer-IP buckets and applicable quota counters are
  stored in process memory. IP bucket entries can remain until the process
  exits; token replenishment is not deletion of the IP entry.
- **Operational logs:** the application emits startup, warning, and error
  records to stderr. Debug logging can include upstream URLs, including
  query parameters. Error messages and stack traces can include request
  fragments or URLs. Hosting infrastructure may collect additional network
  and service logs. Log retention depends on the deployment's provider and
  configured retention settings; this policy does not promise a fixed
  30-day or 90-day deletion period.
- **Support records:** information provided to support is handled to respond
  to the request and address related operational or legal needs. Contact us
  about retention or deletion of a particular support record.

## Uses and limits

We use information to operate the Service, return requested data, limit abuse,
diagnose failures, and respond to support requests. We do not sell personal
information, build advertising profiles from connector usage, or train AI
models on submitted code, queries, or results. The MCP endpoint does not set
advertising cookies or embed browser analytics beacons. These statements do
not govern the separate MCP client or websites you choose to use.

## Self-hosted and authenticated deployments

Operators who self-host this software control their deployment, upstream
endpoints, authentication, logging, and retention. Their privacy policies
apply to their services.

When configured with an OIDC provider such as Clerk, WorkOS, Auth0, or a
generic OIDC issuer, the server validates bearer tokens and processes token
claims, including the subject and granted scopes, for authorization and
quota accounting. The public BLEN endpoint does not require these tokens.
This software does not provide a dynamic client registration service or a
production authorization server merely by enabling an authentication option.

## Your controls

Disconnect the connector in your MCP client to stop future calls. Consult
your client's controls for conversation history and client-side retention.
For questions, access requests, or deletion requests concerning information
held by BLEN, contact **opensource@blencorp.com**. Provide enough context to
locate the relevant interaction, but do not send credentials. A public call
may not have an account identifier that lets us associate it with you.
Self-hosted users should contact their deployment operator.

## Security

The hosted endpoint uses HTTPS. Application safeguards include rate limits,
Host and Origin validation, JavaScript AST preflight, and sandbox isolation.
Sandbox SDK calls are restricted to explicitly registered public methods;
direct network, filesystem, environment, and subprocess access are not
exposed. Execution defaults to a 15-second timeout and a 64 MB heap limit
with the isolated-vm runner. Callers can request values within configured
tool bounds; the Deno fallback does not enforce the `memoryMb` setting.
No safeguard is a guarantee against every security incident.

## Changes and contact

Updates will be published here with a revised date. Privacy questions and
requests: **opensource@blencorp.com**. Report vulnerabilities privately using
the process in [SECURITY.md](../SECURITY.md).
