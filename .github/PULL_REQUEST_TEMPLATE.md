## What

<!-- One paragraph: the change and its motivation. Link issues. -->

## How

<!-- Implementation notes for a reviewer. Highlight non-obvious decisions. -->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] If the portal (`web/`) or docs site (`site/`) changed: `pnpm test:web` passes, and the manual checks in `docs/accessibility.md` were repeated for the changed pages
- [ ] If a portal kit file changed: `pnpm kit:update`, and a follow-up to copy the kit to the other servers
- [ ] If HTTP-visible: added/updated a case in `test/http-integration.spec.ts`
- [ ] If sandbox-visible: added a positive and a negative case in `test/sandbox.spec.ts` (both runners)
- [ ] If new SDK method: added an entry in the source's corpus (`schema/{fr,ecfr,regs}.json`), registered it in the source factory's `methods` table, added it to `test/dispatch.spec.ts`, and updated `docs/sdk-reference.md`
- [ ] No API keys or `.env` files in the diff

## Risk

<!-- Security/perf/back-compat impact. "None" is a valid answer when honest. -->
