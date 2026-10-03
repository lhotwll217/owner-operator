### Investigation

**You own the answer. Plan, route, write.**

Investigation requests are read-only. They produce a cited explanation or a recommendation, not a code change.

1. Route through the [pstack-how](../../pstack-how/WORKFLOW.md) skill. For motivation questions, also route through the [pstack-why](../../pstack-why/WORKFLOW.md) skill.
2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
3. Produce the [pstack-how](../../pstack-how/WORKFLOW.md)-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
4. Apply the [pstack-unslop](../../pstack-unslop/WORKFLOW.md) skill to the reply.

No PR, no babysit, no [pstack-architect](../../pstack-architect/WORKFLOW.md) unless the investigation precedes a code change. If it does, hand back to the user and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?" answers, include your real judgment with reasons. Push back if the premise is wrong (see Autonomy).
