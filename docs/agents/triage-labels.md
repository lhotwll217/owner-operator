---
title: "Triage labels"
summary: "Canonical engineering-workflow labels and their repository mappings"
read_when:
  - Running triage or publishing a spec
  - Translating a skill's workflow state into a GitHub label
---

# Triage Labels

The engineering skills speak in five canonical triage roles. This table maps each role to the repository label.

| Canonical role | Repository label | Meaning |
|---|---|---|
| `needs-triage` | `needs-triage` | A maintainer must evaluate the issue |
| `needs-info` | `needs-info` | Waiting for information |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation |
| `wontfix` | `wontfix` | Will not be actioned |

When a skill names a canonical role, use the mapped repository label.

Other label dimensions remain orthogonal. In particular, `discovery-needed` is a dependency/gate and `discovery` is a task type. Kind, surface, priority, and behavior labels should not be treated as workflow-state aliases. Evolve those dimensions from actual usage rather than designing a complete ontology upfront.
