# Support

This is an independent open-source project. It is not affiliated with or endorsed by the
U.S. government. Help is given on a best-effort basis by the maintainers.

## Before you ask

- **Documentation:** <https://fedreg.mcp.blenlabs.com/docs/> has connect guides for Claude
  Desktop, Cursor and VS Code, key setup, and recipes.
- **SDK reference:** [`docs/sdk-reference.md`](./docs/sdk-reference.md) lists every
  `fr.*`, `ecfr.*` and `regs.*` method, the query patterns, and the errors.
- **Examples:** [`examples/`](./examples/) holds programs you can paste into `execute`.
- **Existing issues:** search the
  [issue tracker](https://github.com/blen-labs/fedreg-mcp-server/issues?q=is%3Aissue), open
  and closed.

## Where to go

| You have | Go to |
|---|---|
| A bug, or behaviour that differs from the docs | [Open a bug report](https://github.com/blen-labs/fedreg-mcp-server/issues/new?template=bug_report.md) |
| An idea for a new SDK method, tool argument or setting | [Open a feature request](https://github.com/blen-labs/fedreg-mcp-server/issues/new?template=feature_request.md) |
| A question about using or hosting the server | [Ask a question](https://github.com/blen-labs/fedreg-mcp-server/issues/new?template=question.md) |
| A security vulnerability (sandbox escape, auth bypass, key leak) | A [private security advisory](https://github.com/blen-labs/fedreg-mcp-server/security/advisories/new). See [`SECURITY.md`](./SECURITY.md). Never a public issue. |
| A problem with your regulations.gov API key | The key comes from api.data.gov: see the [regulations.gov API page](https://open.gsa.gov/api/regulationsgov/) to sign up and the [api.data.gov contact page](https://api.data.gov/contact/) for help with a key. This project cannot see or change your key. |
| A question about the BLEN-hosted service, its terms or your data | **opensource@blencorp.com**. See the [Terms of Service](./legal/terms.md) and [Privacy Policy](./legal/privacy-policy.md). |
| A Code of Conduct concern | **conduct@blenlabs.com**. See the [Code of Conduct](./CODE_OF_CONDUCT.md). |

## What to include

A report we can act on has:

- the server version (the version your MCP client shows for `fedreg-mcp-server`, or your
  git SHA; `npm view` shows the newest release, not the one you run), the transport (stdio or HTTP), the sandbox runner (`isolate` or
  `deno`), your Node version and your MCP client;
- the exact code you passed to `execute`, or the `search_api` query;
- the full error envelope (`{ ok, error: { name, message, status }, logs }`);
- server log lines, if you have them (`FEDREG_LOG_LEVEL=debug` gives more detail).

**Never paste an API key.** The server keeps the key out of results and logs, but a client
configuration file or a shell history does not.

## What we cannot do

- Give legal advice, or interpret a regulation, rule or comment for you.
- Speed up, repair or explain an outage of the Federal Register, eCFR or regulations.gov
  APIs. When an endpoint changes upstream, a bug report with the request and the response
  status is the fastest way to get the SDK updated.
- Share an API key. The regulations.gov key is yours alone; every user needs their own.

## Contributing

To fix something yourself, start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).
