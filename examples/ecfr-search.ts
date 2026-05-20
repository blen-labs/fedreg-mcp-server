/**
 * Example: find sections in Title 40 (EPA) of the CFR that mention "greenhouse gas",
 * grouped by hierarchy, then drill into one section.
 */
declare const ecfr: any;

(async () => {
  const counts = await ecfr.search.counts_hierarchy({
    query: 'greenhouse gas',
    agency_slugs: ['environmental-protection-agency'],
  });

  const top = await ecfr.search.results({
    query: 'greenhouse gas',
    agency_slugs: ['environmental-protection-agency'],
    per_page: 5,
    order: 'relevance',
  });

  return { counts, top };
})();
