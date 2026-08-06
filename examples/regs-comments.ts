// Paste into the `execute` tool. Requires FEDREG_REGS_API_KEY on the server;
// without it, regs.* calls return SourceUnavailable while fr/ecfr keep working.
//
// The fr → regs bridge: find a Federal Register rule, then pull the public
// comments filed on it. Note that `frDocNum` is a *returned* attribute on
// regulations.gov documents, NOT a filter — you bridge via filter.searchTerm
// and then comment on the document's objectId.
declare const fr: any;
declare const regs: any;

(async () => {
  // 1. Newest methane RULE in the Federal Register.
  const rules = await fr.documents.search({
    conditions: { term: 'methane', type: ['RULE'] },
    fields: ['document_number', 'title', 'publication_date'],
    per_page: 1,
    order: 'newest',
  });
  const rule = rules.results?.[0];
  if (!rule) return { error: 'no matching rule' };

  // 2. Locate that rule on regulations.gov via its FR document number.
  const rd = await regs.documents.search({
    filter: { searchTerm: rule.document_number },
  });
  const objectId = rd.data?.[0]?.attributes?.objectId;
  if (!objectId) return { rule, comments: [], note: 'not yet on regulations.gov' };

  // 3. Public comments filed on it (page[size] max is 250; a single query
  //    caps at ~5000 results — cursor by lastModifiedDate to go deeper).
  const comments = await regs.comments.search({
    filter: { commentOnId: objectId },
    sort: '-postedDate',
    page: { size: 25 },
  });

  return {
    rule,
    totalComments: comments.meta?.totalElements,
    latest: comments.data?.slice(0, 5).map((c: any) => ({
      id: c.id,
      title: c.attributes?.title,
      postedDate: c.attributes?.postedDate,
    })),
  };
})();
