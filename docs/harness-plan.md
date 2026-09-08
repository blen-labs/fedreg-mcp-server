# Regulation Harness — Brainstorm Outcome & Plan

Status: planning document, September 2026. This captures the decisions from the
harness brainstorm (based on the YC Paper Club talk on AI harnesses) so the next
session can start building instead of re-deciding. Nothing in this file changes
the MCP server itself.

## What we decided

**The project is a learning vehicle, not (yet) a product.** The goal is to
learn the harness patterns from the talk — evals-in-the-loop, skill CRUD,
persistent agents, memory outside the sandbox, the grind tool — by building
them for real, with federal regulation as the domain. A SaaS for compliance
teams and policy/law shops is the *possible later payoff*, and the brainstorm
established what that product would be if the learning pans out (see
"Product thesis, parked" below). But nothing in v1 is built to SaaS grade.

**The harness is a separate repo** (working name: `fedreg-harness`) that talks
to `fedreg-mcp-server` over Streamable HTTP as a real MCP client. The
harness/tool boundary from the talk stays physical, and it dogfoods this
server's HTTP transport, auth, and quotas.

**The chassis is Vercel's eve** (open-source, Apache-2.0, public preview as of
June 2026): file-system-first agent framework with tools, skills-as-files,
sub-agents, schedules, evals, and durable execution built in; provider-flexible
via the AI SDK, so it runs on Claude. Eve replaces the loop plumbing; the
learning-bearing pieces (eval content, verification, skill-writing,
memory schema) are still hand-built. If the week-one spike fails (below),
fall back to a hand-rolled loop over the Anthropic API.

## Why the harness earns its keep (the moat logic)

Generic deep research (ChatGPT/Claude) wins at one-off regulatory questions —
don't compete there. The structural advantages of an agent on top of this
server's APIs, which search-based deep research cannot match:

1. **Push, not pull** — standing watchlists with agents that wake on schedule.
2. **Enumeration, not sampling** — `fr.documents.search` can provably touch
   every document an agency published in a window. Completeness claims
   ("all 47 EPA documents this week, 3 touch your parts") are checkable.
3. **Auditable grounding** — every claim traces to a recorded API call with an
   FR document number / docket ID / eCFR citation, machine-verifiable.
4. **Comment analysis at scale** — paginated API pulls over 10k-comment
   dockets, not web reading.

The promise, if this ever ships: *continuous, complete, auditable coverage* —
not "smart answers."

## The curriculum (build order)

Each stage exists because the previous one measures it. A layer that doesn't
move the eval number gets deleted.

### 1. Verifiable eval gauntlet (foundation)
Generate a benchmark of regulation questions whose answers are **checkable by
code**, because the same APIs that the agent queries are the ground truth:
"how many EPA rules amended 40 CFR 60 in 2024," "which docket got the most
comments on X," "what did section Y say on date Z." Score the naive
Claude + MCP loop as the baseline. This is the talk's core loop — harness
changes matter more than model changes, *measured*.

### 2. Skill library (first harness layer)
Voyager-style: the agent saves working TypeScript query snippets as named
skill files and composes them later. Eve's skills-as-files makes the
self-improvement step natural — the agent CRUDs its own skill directory.
The gauntlet decides whether skills raise the score.

### 3. Comment-corpus grind (hard eval category)
One brutal task class: position-map every comment on a 10,000-comment docket.
Forces sub-agent fan-out, per-task budgets, aggregation, and a grind tool
(minimum-effort budget so the agent can't give up early). Added to the
gauntlet as its own category.

### 4. Long-horizon monitor (capstone)
The watchlist pipeline, run for real over weeks: structural watch profiles
(agencies + CFR titles/parts + dockets — fully enumerable, so "we saw
everything" is provable; free-text topics only as a best-effort ranking layer
on top), scheduled wakes, state in a database (QM's "brain outside the
sandbox"), diffing against what was seen last time, memory consolidation.
Exercises everything built in 1–3.

## Trust architecture (for stage 4, and the eventual product)

- **Deterministic core**: which documents appeared, which match a profile, and
  deadline dates come from plain code diffing API results. The LLM writes
  prose about facts code already established; it can never be the reason a
  document was missed or invented.
- **Citation verification**: before any output ships, code re-fetches every
  cited document number / docket ID / eCFR section and confirms it exists and
  supports the claim; unverifiable sentences are cut or flagged.
- (Deferred from the brainstorm: second-model adversarial review and a
  human-review period per customer — product-stage concerns, not v1.)

## Week-one spike (go/no-go for eve)

Eve agent → `fedreg-mcp-server --http` → one `execute` call round-trips.
Verifies the two open eve questions: first-class MCP client support, and how
durable execution behaves off-Vercel. If it fails, hand-roll the loop.

## Product thesis, parked

If the harness proves out: hosted SaaS for compliance teams and policy/law
shops. Deliverable is watchlists + cited briefs/alerts. Buyers pay for recall
guarantees and audit trail, not eloquence — a missed rule is a fine. The
server's existing per-subject auth/quota machinery is the multi-tenant
substrate. Revisit only after the curriculum is done and the eval numbers say
the harness works.

## Open questions for the next session

- Eval set design: how many questions, generated how (templates over live API
  data vs. hand-written), and how to keep answers stable as the live corpus
  moves (pin date ranges).
- Where harness state lives (Postgres vs. SQLite for a learning project).
- Grind-tool mechanics in eve: token budget, wall-clock, or tool-call floor.
- Whether the skill library is per-task or global, and how bad skills get
  retired (eval-gated merge, DSPy-style).
