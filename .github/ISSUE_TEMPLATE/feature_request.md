---
name: Feature request
about: Propose a new tool, SDK method, or capability
labels: enhancement
---

## What problem does this solve?

<!-- A paragraph on the use case and who it's for. -->

## Proposed change

<!-- Sketch the API. New SDK method? Tool argument? Configuration knob? -->

## Alternatives considered

<!-- What else did you weigh? Why is this the right shape? -->

## Out of scope

Anything that weakens the sandbox boundary (adding `fetch`, `import`,
filesystem, env, or subprocess access to the `execute` surface) is out of
scope per [CONTRIBUTING.md](../../CONTRIBUTING.md).
