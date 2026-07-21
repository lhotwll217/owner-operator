---
title: "Domain documentation"
summary: "How engineering skills consume Owner Operator's glossary and architectural decisions"
read_when:
  - Exploring the codebase for an engineering skill
  - Naming domain concepts in issues, designs, tests, or implementation
  - Checking whether proposed work conflicts with an architectural decision
---

# Domain Docs

Before exploring, read:

- root [`CONTEXT.md`](../../CONTEXT.md); and
- relevant ADRs under `docs/adr/` when that directory exists.

Proceed silently when an expected document does not yet exist. Domain-modeling workflows create missing documentation when real terminology or decisions emerge.

Use the glossary's exact vocabulary in issues, designs, tests, and implementation. Do not substitute synonyms that `CONTEXT.md` explicitly rejects. If a needed concept is absent, reconsider whether it belongs or record the gap for domain modeling.

If proposed work contradicts an ADR, surface the conflict explicitly rather than silently overriding it.

## Layout

This repository uses one shared context:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```
