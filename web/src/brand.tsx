import type { Brand } from '@/components/kit/brand';

export const brand: Brand = {
  name: 'Federal Regulations MCP',
  tagline: 'Federal rules, regulations and public comments in your AI assistant',
  summary:
    'Search the Federal Register, the Code of Federal Regulations and regulations.gov dockets and comments from the official government APIs, in Claude, ChatGPT, Cursor and other MCP clients.',
  repoUrl: 'https://github.com/blen-labs/fedreg-mcp-server',
  docsUrl: '/docs/',
  license: 'Apache-2.0',
  disclaimer:
    'Independent open-source project; not affiliated with or endorsed by the Office of the Federal Register, the Government Publishing Office, or GSA and the eRulemaking Program.',
  accountPurpose: 'manage your regulations.gov API key',
  connect: {
    signInStep: (
      <>
        Sign in with Google. Federal Register and eCFR need no key; to search regulations.gov dockets and comments, add
        your own free regulations.gov API key. The key is encrypted and used only by this server; your assistant never
        sees it.{' '}
        <a href="/docs/connect/" className="text-foreground underline underline-offset-4">
          How to connect
        </a>
        .
      </>
    ),
    publicNote:
      'Search Federal Register and eCFR without signing in, including running queries. regulations.gov needs your own API key, so use the server URL above for that.',
    guidesHref: '/docs/connect/',
  },
  examples: [
    { title: 'Recent rules', prompt: 'Which final rules did the EPA publish in the Federal Register last month? Summarize the three most significant.' },
    { title: 'Open comment periods', prompt: 'List proposed rules from the FDA that are open for public comment right now, with their comment deadlines.' },
    { title: 'Regulation text', prompt: 'Show me the current text of 14 CFR 91.103 and tell me when it last changed.' },
    { title: 'Compare versions', prompt: 'How did 40 CFR 60.5 read a year ago compared with today?' },
    { title: 'Dockets', prompt: 'Find the regulations.gov docket for the Department of Labor’s overtime rule and list its documents.' },
    { title: 'Public comments', prompt: 'How many comments were submitted on docket EPA-HQ-OAR-2021-0208, and what do the most recent ones say?' },
  ],
  sources: [
    {
      name: 'Federal Register API',
      description: 'Daily rules, proposed rules, notices and presidential documents, agencies, issues and public inspection.',
      href: '/docs/reference/sdk/',
    },
    {
      name: 'eCFR API',
      description: 'The Electronic Code of Federal Regulations: titles, structure, current text, version history and search.',
      href: '/docs/reference/sdk/',
    },
    {
      name: 'regulations.gov API',
      description: 'Rulemaking dockets, documents and public comments. Needs your own regulations.gov API key.',
      href: '/docs/reference/sdk/',
    },
  ],
  howItWorks: [
    {
      title: 'Three tools',
      body: 'Your assistant searches the API reference, reads field definitions, and writes a short program instead of calling dozens of narrow tools.',
    },
    {
      title: 'A locked-down sandbox',
      body: 'Programs run without network, filesystem or environment access. They can only call the Federal Register, eCFR and regulations.gov methods this server exposes.',
    },
    {
      title: 'Your own key for regulations.gov',
      body: 'Federal Register and eCFR are open. Your regulations.gov key is encrypted at rest, used only for your requests, and paced to the API’s hourly limit.',
    },
  ],
  howItWorksHref: '/docs/how-it-works/',
};
