// Paste into the `execute` tool. The current text of one eCFR section, plus the newest
// Federal Register rules on the same subject, so an answer can cite both.

// 1. The eCFR is versioned by date: ask for the title's latest issue date, then that day's section.
const { titles } = await ecfr.titles.list();
const date = titles.find(t => t.number === 50).latest_issue_date;
const xml = await ecfr.full(date, 50, { part: '21', section: '21.150' });

// 2. Related rulemaking in the Federal Register.
const rules = await fr.documents.search({
  conditions: { term: 'migratory bird depredation', type: ['RULE', 'PRORULE'] },
  fields: ['document_number', 'title', 'publication_date', 'html_url'],
  per_page: 3,
  order: 'newest',
});

// 3. Return a bounded result: the section as plain text (the full XML can be large) and the rules.
return {
  section: {
    citation: '50 CFR 21.150',
    asOf: date,
    url: 'https://www.ecfr.gov/current/title-50/section-21.150',
    text: xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
  },
  rules: rules.results,
};
