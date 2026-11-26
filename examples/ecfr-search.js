// Paste into the `execute` tool. Where "greenhouse gas" appears in the Code of Federal
// Regulations for one agency: counts by CFR title, then the best matching sections.

const query = 'greenhouse gas';
const agency_slugs = ['environmental-protection-agency'];

// The counts come back as a tree (title > chapter > part ...); keep its top level.
const counts = await ecfr.search.counts_hierarchy({ query, agency_slugs });
const top = await ecfr.search.results({ query, agency_slugs, per_page: 3, order: 'relevance' });

return {
  matchingSections: counts.count.value,
  byTitle: counts.children.map(t => ({ title: t.hierarchy, heading: t.heading, sections: t.count })),
  best: top.results.map(r => ({
    title: r.hierarchy.title,
    part: r.hierarchy.part,
    section: r.hierarchy.section,
    heading: r.headings.section,
  })),
};
