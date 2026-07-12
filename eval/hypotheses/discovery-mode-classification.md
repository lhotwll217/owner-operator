# Discovery-mode classification

## Campaign outcome

| Field | Result |
| --- | --- |
| Status | Accepted; no further LLM evals required for this campaign. |
| Product decision | Progressive disclosure is a fallback for unresolved uncertainty, not the default retrieval route. Owner Operator classifies direct, indexed, ambiguous, and exhaustive requests; the skill selects the lightest transcript operation. |
| Accepted mechanisms | Exact widget-state filtering; stable DB/session IDs; grouped candidates; hard output budgets; scoped in-session queries with omission feedback; identifier-first literal search; tolerant `--any`, regex, and leading-dash query handling. |
| Rejected mechanisms | Fixed call/stop budgets; default candidate→window choreography; brittle exact repo/topic filters; abstract mode labels without an executable query heuristic. |
| Global evidence | Current accepted full run: 100% OO correctness versus 85.7% baseline, with 3.02 versus 4.79 mean tool calls. On the ten shared PR cases, OO stayed at 100% while mean calls moved from 3.70 to 2.70. |
| Limitations | PR #33 used a different model/token accounting; cross-PR token values are not comparable. The last universal parser fixes have deterministic and targeted coverage newer than the accepted global run. |
| Follow-ups | Improve database-schema discoverability for audit questions; evaluate replay/candidate deduplication separately only if it recurs. |

The ownership seam is deliberate: the system prompt owns cross-tool intent classification; the
reusable skill owns transcript-operation selection; tool implementations own contracts, ranking,
pointers, privacy, and bounded context.

## Fast-cycle evidence

All probes used `openai-codex/gpt-5.6-sol`, the shipped Owner Operator prompt and bundled skill,
the same naive arm, and `claude-fable-5` grading. Each row is one execution per arm; correctness
and transcript evidence remained gates while calls diagnosed the route.

| Probe | Before / first attempt | Accepted trajectory | Finding |
| --- | --- | --- | --- |
| `evidence-flaky-why-fakeclock` | 3 calls | 2 calls | Abstract modes alone changed nothing; identifier-first literal search removed candidates + drill. |
| `evidence-429-root-cause` | 3-call prior mean | 2 calls | A sufficient first result stopped without a forced window. |
| `state-what-needs-me` | 1-call prior mean | 1 call | Indexed state routing stayed exact and authoritative. |
| `duplicate-topic-disambiguation` | 4-call prior mean | 4 calls | Ambiguity still used state to locate both ids and read both transcripts. |
| `locator-dexie-decision` | 3-call prior mean | 3 calls | Direct query worked; its preview declared truncation, so the anchored drill was necessary evidence work. |
| `negative-graphql` | 2.7-call prior mean | 3 calls | Exhaustive search stayed in the coding namespace and consolidated variants with `--any`. |
| `cross-source-decision-reversal` | 4.7-call prior mean | 5 calls | Treating a prose topic label as ambiguous removed a guaranteed zero-hit query and restored the healthy two-session path. |

The fresh causal rung is recorded as `discovery-mode fast baseline` → `direct-anchor classifier`
(rejected: no behavior change) → `identifier-first direct mode` (accepted). Distributed probes
are `mode classifier spray one`, `mode classifier spray two`, `mode boundary correction`, and
`exhaustive any coverage` in `eval/history.jsonl`.

## Accepted mechanism

Choose the shortest adequate mode, then reclassify from each observation. Identifier-shaped
literals begin with a literal query; state-only questions stay indexed; ambiguity earns grouped
candidates; completeness earns explicit coverage. Stop when the returned evidence is sufficient.
No fixed call budget or mandatory tool choreography is introduced.

## Tool-interface follow-up

Three deterministic defects were fixed at the reusable session-grep seam rather than with more
harness routing policy:

- `--any` now treats both whitespace and `|` as term delimiters, so agent-generated OR notation
  produces real per-term `word_hits` instead of impossible literal tokens.
- Query matches share the global `--max-chars` aperture. A small result set can return complete
  short messages instead of clipping every match at 300 characters; busy result sets stay compact.
- Regex search accepts the common leading `(?i)` modifier. Matching was already case-insensitive,
  so normalization removes an otherwise wasted error/correction turn without changing semantics.

The focused `tool interface bug fixes` run passed both affected cases. `negative-graphql` used four
Owner Operator calls versus six for the naive arm; `locator-dexie-decision` stayed at three calls
because the model chose grouped candidates, whose contract intentionally returns a pointer rather
than the full match. Therefore that run proves correctness and useful pipe feedback, not a Dexie
call reduction from the preview change. The later `regex compatibility fast proof` also passed at
four versus six calls: no tool failed, and the model chose two independent regex coverage checks in
parallel. The deterministic regression, not a stochastic call-count claim, is the acceptance gate.

Validation ownership follows the implementation seam. The upstream repository owns the primitive's
CLI regressions and portable `--self-test`; Owner Operator executes that self-test from the vendored
copy and owns only thin wrapper/privacy/source-policy assertions. The full upstream test tree is not
duplicated here. Until the adjacent upstream delta is published and the vendor is re-pinned, the
pending-delta note in `vendor/session-grep/UPSTREAM.md` documents the intentional drift.

## Remaining-suite sanity

The unrepeated `post-tool-fix remaining-suite sanity` run covered the 12 cases outside the two
targeted tool probes. Owner Operator passed 12/12 versus 10/12 for the naive arm, used 40 versus
48 tool calls, and used 0.99x the tokens at 1.10x cost. The adjacent Dexie and negative probes
also passed, so all 14 cases were correct across the split runs; because their manifests differ,
that is coverage evidence rather than one global current-state snapshot. Promptfoo exited nonzero
because the control arm failed `state-what-needs-me` and `handoff-needs-me-evidence`; the paired
comparator correctly passed because Owner Operator had no per-case regression.

The sweep earned one additional parser regression. An agent searched for the literal
`--units units flag units`; Owner Operator's wrapper rejected a value beginning with dashes, and
the shared primitive would then have allowed ripgrep to interpret `--units` as its own option.
Red tests reproduced both boundaries. The wrapper now accepts leading-dash query values, while the
primitive places an option terminator before positional patterns. Upstream CLI tests, the portable
58-assertion self-test, and the privacy-aware wrapper integration exercise the complete sanctioned
path. The one-case `leading-dash query fast proof` stayed correct at three calls but chose widget
state → stable ID → skim, so it is regression evidence, not causal proof of the query path.

One unrelated efficiency observation remains: `audit-thread-escalation` passed but used seven calls,
including `list_tables`, two `describe_table` calls, and the final history query. That suggests a
database-schema discoverability opportunity; it is not evidence of a session-search regression and
does not justify changing the accepted retrieval mechanism in this campaign.

## Historical baseline comparison

The fixed pre-work reference is the accepted controlled global result in PR #33, not an earlier
run from this development branch. That result used 10 cases at `gpt-5.5`: both arms passed 10/10,
Owner Operator averaged 3.70 calls per evaluation, and the baseline averaged 5.70. Its PR-level
provenance and aggregate metrics are retained in `eval/eval_stat_log.json`; the original raw result
was not committed, so the entry explicitly identifies the PR head at merge rather than claiming an
exact-run manifest.

The latest complete global result is the backfilled `post-fix full 3x final` run on `main` at
`3a47ef4`; its manifest and dirty-worktree fingerprint identify the evaluated state. On the 10
shared cases, Owner Operator preserved 100% correctness while mean calls fell from 3.70 to 2.70
(-27%). The baseline fell from 100% to 80% correctness while mean calls fell from 5.70 to 4.93.
OO's mean tool-call reduction versus the baseline widened from 35.1% to 45.3%, although the model
and harness changed, so the across-PR delta is observational rather than a controlled causal estimate.

Across the complete current 14-case suite, Owner Operator achieved 100% correctness versus 85.7%
for the baseline and averaged 3.02 versus 4.79 calls per evaluation. The four added cases reached
100% in both arms, averaging 3.83 versus 4.42 calls. The immediately preceding valid full run used
the same model, suite, repeat, and transport: the accepted fixes moved Owner Operator from 95.24%
to 100% correctness and from 3.12 to 3.02 mean calls. This is the stronger within-campaign evidence.

The subject model changed from `gpt-5.5` to `gpt-5.6-sol`, and token accounting changed
substantially; raw token distributions remain in the stats artifact, but their across-PR values are
not treated as apples-to-apples efficiency evidence. The accepted full run predates the final
targeted session-grep interface fixes, whose affected and remainder cases were subsequently
validated on newer manifests.
