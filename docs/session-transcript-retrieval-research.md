# Session transcript retrieval

## Conclusion

Treat a 19-call search as a retrieval-interface failure to diagnose, not a behavior to
stop. The established pattern is:

1. use an exact session identifier when one is already known;
2. otherwise rank candidate sessions cheaply;
3. return stable message anchors with small evidence windows and session bookends;
4. expand or reformulate the query from retrieved evidence;
5. drill into only the promising anchors.

`session-grep` already has pieces of this design (`--overview`, `--skim`,
`--session … --at …`, rarity-ranked `--any`), so the next work should strengthen those
seams rather than add a stop rule or create a second retrieval stack. Its existing
headless benchmark is also the right harness pattern: the same model and read-only tool
floor, with session-grep injected into the treatment arm and plain grep retained as the
control. The benchmark measures correctness and the trajectory, not calls alone.
([tool and control](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/README.md#L85-L105),
[iteration ladder and trajectory artifacts](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/eval/AUTORESEARCH.md#L12-L77))

The experiment history also shows why a single impressive trace is insufficient: the
one-case word-OR treatment produced 4 calls/pass against 14 calls/fail for the control,
then lost the three-case efficiency probe; a later bounded-output treatment passed both its
three-case probe and core; browse modes cut one summary path from 17 calls to 2 but did
not pass the expanded core gate
([iterations 1–4](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/eval/history.jsonl#L3-L15)).
Those are retrieval hypotheses being falsified or promoted, not evidence for a global
call ceiling.

## What to borrow

### Exact identity before retrieval

When Owner Operator's database has a source session ID and transcript path, that is a
locator, not a search hint. The transcript tool should accept the canonical ID exactly,
resolve it to one transcript, and return the same ID with stable message anchors. This
removes query generation and ranking from the common “DB row → transcript evidence”
route.

Hermes Agent is maintained prior art for this contract. Its session tool exposes
discovery, direct read, anchored scroll, and browse as shapes of one tool
([modes](https://github.com/NousResearch/hermes-agent/blob/caf557be5b4c9ae75b3a7566d65d3df2c701c5df/tools/session_search_tool.py#L5-L29));
it searches profile databases read-only for a globally unique bare ID
([ID lookup](https://github.com/NousResearch/hermes-agent/blob/caf557be5b4c9ae75b3a7566d65d3df2c701c5df/tools/session_search_tool.py#L167-L208))
and normalizes linked `profile/id` values before dispatch
([normalization](https://github.com/NousResearch/hermes-agent/blob/caf557be5b4c9ae75b3a7566d65d3df2c701c5df/tools/session_search_tool.py#L619-L664)).

At the inspected `session-grep` revision, `sessionId(file)` is only the JSONL basename
([implementation](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/skills/session-grep/session-grep.mjs#L373-L375)).
That is not a sufficient canonical-ID contract for sources whose filename wraps the
source ID. Fixing this mapping is upstream of prompt coaching.

### Progressive disclosure should return pointers, not uniformly clipped prose

Coarse-to-fine reading is an established retrieval pattern: Choi et al. first select
sentences cheaply and then apply the expensive reader only to them, improving speed
3.5–6.7× in their long-document experiments
([paper abstract](https://aclanthology.org/P17-1020/)). Hermes applies the same shape to
sessions: discovery returns the match window plus opening and closing bookends
([discovery result](https://github.com/NousResearch/hermes-agent/blob/caf557be5b4c9ae75b3a7566d65d3df2c701c5df/tools/session_search_tool.py#L499-L616));
the agent can then scroll around the returned message ID
([anchored scroll](https://github.com/NousResearch/hermes-agent/blob/caf557be5b4c9ae75b3a7566d65d3df2c701c5df/tools/session_search_tool.py#L303-L424)).

`session-grep` already offers overview → sampled skim → anchored window
([browse and window modes](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/skills/session-grep/session-grep.mjs#L164-L192)),
but the inspected skim first clips every message to 200 characters and only then samples
those lines
([skim implementation](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/skills/session-grep/session-grep.mjs#L392-L436)).
That can discard the decisive half of a conversational message before the global output
budget is allocated. A better disclosure unit is a complete short message or a
query-centred fragment with a stable anchor and an explicit continuation pointer.
SQLite FTS5 already supplies bounded, match-centred snippets of up to 64 tokens
([`snippet()`](https://sqlite.org/fts5.html#the_snippet_function)).

### Let the tool do retrieval math

SQLite's BM25 implementation ranks matching rows using phrase frequency, document
length, and inverse document frequency; its IDF is derived from total rows and rows
containing the phrase
([FTS5 `bm25()`](https://sqlite.org/fts5.html#the_bm25_function)). This supports the
current intuition that rare identifiers, filenames, error fragments, and proper nouns
should dominate common words. It also exposes an important design choice: the unit of
“document” determines the statistic.

The current `--any` implementation calculates IDF over messages in files that matched
at least one proposed word and reports per-word hit counts
([ranking](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/skills/session-grep/session-grep.mjs#L227-L273),
[feedback](https://github.com/lhotwll217/session-grep/blob/7622a53c135062c18e29040b63e810aeb6f93265/skills/session-grep/session-grep.mjs#L294-L342)).
Because the user is trying to find a *session*, corpus-wide session document frequency
may rank better than matched-file message frequency; that is an inference to test, not
an assumption to ship.

Vocabulary expansion can help, but free-form synonyms can drift away from private,
project-specific language. Corpus-Steered Query Expansion instead selects pivotal text
from initial results and feeds corpus terms back into retrieval
([Lei et al., abstract](https://aclanthology.org/2024.eacl-short.34/)). IRCoT likewise
found one-shot retrieval insufficient for multi-step questions and improved retrieval
by interleaving the next query with facts already recovered
([method and results](https://arxiv.org/html/2212.10509#S3.SS1)). For session search, the cheap
version is to return rare neighbouring terms or entities from the first result so the
agent can issue a grounded second query; it does not require embeddings.

### Teach trajectories, not just flag descriptions

ReAct prompts models with complete thought/action/observation demonstrations. Its
examples explicitly include question decomposition, evidence extraction, and search
reformulation, and it reports improvements over acting-only baselines
([§3.1](https://arxiv.org/pdf/2210.03629#page=5)). The practical implication is to test two or
three short retrieval demonstrations:

- known ID → direct read → anchored scroll;
- factual question → several candidate terms in one rarity-ranked search → anchor;
- broad retrospective → overview → skim/bookends → targeted verification.

These examples should use unrelated fixture vocabulary. They teach the tool protocol
without leaking an eval answer or prescribing a call count.

### Optimize from full trajectories

GEPA's maintained implementation reads execution traces and textual evaluator feedback,
then selects, reflects, mutates, and retains candidates on a Pareto frontier
([algorithm](https://github.com/gepa-ai/gepa/blob/92dadfffbe98c8ecf508179a1cab09c1bb85cd32/README.md#L135-L145)).
OPRO similarly keeps prior prompt/score pairs in the optimizer prompt
([§2.2](https://arxiv.org/html/2309.03409#S2.SS2)) and separates prompt-optimization
training examples from test evaluation
([§4.1–4.2](https://arxiv.org/html/2309.03409#S4)). Owner Operator does not need to
invent an optimizer to adopt the pattern: preserve tool inputs, result sizes, anchors,
errors, and answers; label the causal failure; change one retrieval mechanism; replay
paired cases; validate on held-out cases. If this loop is automated later, GEPA already
has RAG and MCP adapters rather than requiring a local optimizer.

## Hypotheses worth an eval case

Calls and returned characters are diagnostic measures. Correct answer and correct
evidence remain the gates.

| Hypothesis | Treatment | A case earns its place when | Primary measures |
|---|---|---|---|
| **H1: canonical ID bypasses search** | Pass the DB's exact source session ID to direct read; return stable message IDs. | The answer is in a known session whose filename does not equal its canonical ID. | exact-session success, calls before first evidence, wrong-session rate |
| **H2: anchors beat 200-character clipping** | Return match-centred windows plus opening/closing bookends; allocate the total budget dynamically. | A decisive fact occurs after character 200 or in the unsampled middle, and can be reached from a returned anchor. | evidence recall, returned characters, answer correctness |
| **H3: session-level IDF improves discovery** | Compare distinct-word count, current matched-file/message IDF, corpus-wide message BM25, and corpus-wide session IDF. | Several sessions share common words but one contains a rare identifying term. | MRR and recall@k for the target session, downstream correctness |
| **H4: structured candidate terms beat one literal string** | Let the agent submit a list of lexical anchors; the tool handles OR, deduplication, IDF, and term statistics. | Natural-language phrasing differs from the transcript, but at least one identifier, artifact, or proper noun overlaps. | zero-hit rate, reformulations, MRR, correctness |
| **H5: corpus-steered second queries beat free synonyms** | Return rare neighbouring terms from top snippets; compare grounded expansion with unconstrained synonym generation and no expansion. | The first query finds a related but incomplete fact and a second hop is required. | second-hop recall, query drift, total evidence returned |
| **H6: tool-use examples improve the front end** | Compare flag prose alone with the same prose plus the three unrelated trajectories above. | The tool can answer efficiently, but the baseline agent chooses broad literals, repeats search, or fails to consume anchors. | correctness, successful anchor use, redundant queries, result characters |

Run these in the existing paired headless harness: naive grep control, current
session-grep baseline, then one treatment at a time. Promote a case only when it isolates
a failure mode not already represented, has a stable evidence-backed answer, and can
distinguish at least two implementations or trajectories. This keeps the suite a set of
retrieval experiments rather than a growing list of anecdotes.
