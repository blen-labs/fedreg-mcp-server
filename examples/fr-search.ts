/**
 * Example: search Federal Register documents about methane published in 2024 by EPA.
 *
 * This snippet is what an MCP client would pass to the `execute` tool. The sandbox
 * gives you `fr` and `ecfr` as globals; no imports, no fetch, no environment.
 */
declare const fr: any;

(async () => {
  const recent = await fr.documents.search({
    conditions: {
      term: 'methane',
      agencies: ['environmental-protection-agency'],
      publication_date: { gte: '2024-01-01' },
      type: ['RULE', 'PRORULE'],
    },
    fields: ['document_number', 'title', 'publication_date', 'type', 'html_url'],
    per_page: 25,
    order: 'newest',
  });
  return recent;
})();
