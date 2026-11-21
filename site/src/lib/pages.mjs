// The site's pages, in sidebar order. The sidebar, the Markdown copy of each page, and the page
// actions are all built from this list. Each label is the page's title.
export const home = { label: 'Overview', slug: 'index' };

export const groups = [
  {
    label: 'Start',
    pages: [
      { label: 'Get your keys', slug: 'keys' },
      { label: 'Connect your assistant', slug: 'connect' },
    ],
  },
  {
    label: 'Use',
    pages: [
      { label: 'How it works', slug: 'how-it-works' },
      { label: 'Recipes', slug: 'recipes' },
    ],
  },
  {
    label: 'Reference',
    pages: [
      { label: 'Tools', slug: 'reference/tools' },
      { label: 'SDK reference', slug: 'reference/sdk' },
    ],
  },
  {
    label: 'Run your own',
    pages: [
      { label: 'Self-host', slug: 'self-host' },
      { label: 'Security', slug: 'security' },
    ],
  },
];

export const pages = [home, ...groups.flatMap((group) => group.pages)];

// starlight-llms-txt writes one file for each document set and names it after the set's label,
// with the rule of a GitHub heading anchor. scripts/check-links.mjs fails the build if a file
// is not where this says.
const fileName = (label) => label.toLowerCase().replace(/[^a-z0-9 -]/g, '').replaceAll(' ', '-');

/** The site path of a page's Markdown copy, or undefined when the page has none. */
export const markdownPath = (slug) => {
  // Starlight gives the home page an empty id.
  const page = pages.find((candidate) => candidate.slug === (slug || home.slug));
  return page && `/_llms-txt/${fileName(page.label)}.txt`;
};
