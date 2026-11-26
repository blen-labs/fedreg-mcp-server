// Paste into the `execute` tool. A search that matches nothing is not an error: the call
// succeeds, `count` is 0, and there are no results. Check for that before reading results[0].
const none = await fr.documents.search({
  conditions: { term: 'zzqxv-no-such-regulation' },
  fields: ['document_number', 'title'],
  per_page: 5,
});
return { count: none.count, results: none.results ?? [] };
