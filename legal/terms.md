# Terms of Service — Federal Register & eCFR Explorer (by BLEN)

_Last updated: 2026-09-22_

## 1. Acceptance and scope

By accessing or using the BLEN-hosted **Federal Register & eCFR Explorer**
at `https://fedreg.mcp.blenlabs.com/mcp` (the "Service", operated by BLEN,
Inc.), you agree to these terms. If you do not agree, do not use the Service.
If you use it on behalf of an organization, you represent that you are
authorized to accept these terms for that organization.

The underlying `@blen/fedreg-mcp-server` software is separately licensed
under [Apache-2.0](../LICENSE). These hosted-service terms do not replace
that license or restrict rights it grants. A self-hosted deployment is
operated under its operator's terms and policies.

## 2. Independent service and data sources

The Service is an independent, read-only client for the public Federal
Register and eCFR APIs. The software also supports regulations.gov when a
deployment enables that source with a server-side API key. Availability of
a source in bundled documentation does not guarantee it is enabled on the
hosted endpoint.

BLEN is not affiliated with, sponsored by, or endorsed by the U.S.
government, the Office of the Federal Register, the National Archives and
Records Administration, the Government Publishing Office, or the operators
of regulations.gov. Third-party content remains subject to any applicable
rights and source notices. These terms grant no rights to government seals,
trademarks, or third-party material beyond those otherwise available to you.

## 3. Informational use and accuracy

The Service is for informational and research purposes. It does not provide
legal advice, determine compliance, issue permits, or replace authoritative
government publications or professional judgment.

Upstream data can contain errors, omissions, or delays. Responses can be
cached, and code or an AI client may filter, calculate, or summarize results
incorrectly. Retrieval of a historical document does not establish that it
remains in effect. Verify dates, amendments, citations, and source documents
before relying on an answer or taking action.

FederalRegister.gov and eCFR.gov describe the status and limitations of
their electronic content. For legal research, verify against the applicable
official publications, including those available through
[GovInfo](https://www.govinfo.gov/). See the
[FederalRegister.gov legal-status notice](https://www.federalregister.gov/reader-aids/government-policy-and-ofr-procedures/about-this-site)
and [eCFR explanation](https://www.ecfr.gov/reader-aids/understanding-the-ecfr/what-is-the-ecfr).

## 4. Acceptable use

You agree not to:

- Bypass or attempt to bypass sandbox isolation, rate limits, authentication,
  or other access controls.
- Submit code or queries intended to extract secrets, access host internals,
  target unsupported systems, modify upstream records, or cause excessive load.
- Send credentials, confidential records, or sensitive personal information
  through the public connector.
- Use the Service unlawfully, infringe others' rights, or harass or target
  individuals using public records.
- Misrepresent Service outputs as government approval or an official legal
  determination.

We may limit, suspend, or block access to address violations, abuse, security
incidents, or threats to service availability.

## 5. Limits and source availability

The Service applies request-rate, execution, memory, and upstream limits.
Limits depend on the deployment configuration and may change. The default
execution timeout is 15 seconds, and the isolated-vm runner defaults to a
64 MB heap limit; callers may request values within the tool's allowed
bounds. Shared infrastructure and public-access quotas can affect multiple
users. Upstream providers may impose additional limits or become unavailable.

The three tools are `search_api`, `describe_schema`, and `execute`.
`execute` accepts plain JavaScript, not TypeScript type annotations, and is
limited to the registered read-only SDK surface. The Service does not submit
public comments, make filings, or perform other mutative government actions.

## 6. Privacy

The [Privacy Policy](./privacy-policy.md) describes tool arguments, network
metadata, upstream disclosures, caching, and operational logging. Your MCP
client and any self-hosted operator have separate practices and terms.

## 7. Availability and warranty

The Service is provided **"as is"** and **"as available"**. To the maximum
extent permitted by law, BLEN disclaims warranties, including merchantability,
fitness for a particular purpose, and non-infringement. We do not guarantee
accuracy, uninterrupted availability, compatibility with every MCP client,
or continued free access. We may change or discontinue the hosted Service.

## 8. Liability

To the maximum extent permitted by law, BLEN, Inc. disclaims liability for
direct, indirect, incidental, special, or consequential damages arising
from use of or inability to use the Service. Nothing in these terms excludes
liability that cannot lawfully be excluded.

## 9. Changes

We may update these terms. Material changes will be noted in the repository
changelog at least 14 days before taking effect for the hosted Service.
If you do not agree to revised terms, stop using the Service.

## 10. Governing law

These terms are governed by the laws of Delaware, USA, subject to applicable
mandatory law.

## 11. Contact

Questions about these terms: **opensource@blencorp.com**. General support is
also available through [BLEN's contact page](https://www.blencorp.com/connect).
Report security vulnerabilities privately as described in
[SECURITY.md](../SECURITY.md).
