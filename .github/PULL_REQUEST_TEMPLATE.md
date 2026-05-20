## What

<!-- One paragraph: the change and its motivation. Link issues. -->

## How

<!-- Implementation notes for a reviewer. Highlight non-obvious decisions. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] If HTTP-visible: added/updated a case in `test/http-integration.spec.ts`
- [ ] If sandbox-visible: added a positive and a negative case in `test/sandbox.spec.ts`
- [ ] If new SDK method: added an entry in `schema/field-dictionary.json`

## Risk

<!-- Security/perf/back-compat impact. "None" is a valid answer when honest. -->
