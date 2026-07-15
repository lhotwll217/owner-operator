---
name: session-search
description: Search coding-agent or Owner Operator session transcripts through Owner Operator's privacy-aware session-grep policy. Use when exact text, regex, transcript evidence, prior conversation details, or a bounded view of a known session is needed.
---

# Session search

Run the bundled privacy-aware helper through `bash`. `OO_INSTALL_ROOT` points at the active Owner Operator installation. Do not read transcript files directly or call the vendored primitive.

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --query 'TEXT' --since 7d"}
```

Discovery queries exclude the calling coding-agent session when its stable ID is available
from provenance. The query header reports `caller_session_exclusion=applied:ID` or
`unavailable`, so prompt-echo risk is explicit. Owner Operator's own saved conversations
are a separate namespace, excluded from normal coding-session search; add
`--owner-operator` only when the user explicitly asks for Owner Operator history or scheduled
runs. Unqualified “any session” or “every session” broadens only within the normal coding-session
namespace; it does not opt into Owner Operator history.

## Choose the lightest search mode

- **Known session:** use its stable id directly. Choose a scoped query for one fact, `--skim`
  for a short conversation or narrative view, and an anchored window for a known message.
- **Distinctive anchor:** when the question contains a high-information literal—for example a
  `CamelCase` or `snake_case` identifier, error code, path, PR number, or quoted phrase—query
  that literal alone first with enough bounded context to test the answer. Do not dilute it
  with generic question words or request grouped candidates unless the result is ambiguous or
  insufficient. An unknown session id alone is not ambiguity. If the hit supplies the requested
  evidence, stop. A prose topic label is not a verbatim anchor merely because it is hyphenated;
  use ambiguous discovery when its wording may be a paraphrase.
- **Ambiguous or paraphrased target:** use several independent lexical anchors with `--any`
  and group them with `--candidates`, then drill into promising pointers.
- **Exhaustive claim:** make the time and source scope explicit. Put independent anchor variants
  into one `--any` query (whitespace and `|` both delimit terms) and use its per-term
  `word_hits`, match totals, and omissions as the coverage report. Search again only when
  retrieved evidence grounds a new term or the report shows incomplete coverage; then qualify
  any absence or completeness claim.

These modes can change after a result. Zero hits warrant reformulation; multiple plausible
sessions warrant candidates; a resolved id warrants scoped retrieval. They are not a mandatory
query → candidate → skim → window sequence.

## Find transcript evidence

- `--query TEXT` performs literal search, including values that begin with dashes such as `--units`; add `--regex` only when the user needs a pattern. Regex matching is case-insensitive by default; a leading `(?i)` is accepted for grep compatibility.
- Add `--role user` or `--role assistant` to search only that side of the conversation;
  `--role all` is the default.
- Multi-word text is still one literal phrase. Use `--any` when several independent terms
  should match; the rarest hits rank first.
- For ambiguous discovery, add `--candidates --limit 8`. It groups the complete ranked match set by
  stable session ID before limits and returns one best pointer per session; drill into a candidate
  rather than feeding many repeated hits from the same transcript into context.
- Prefer a recent `--since` window before broadening.
- Use enough `--before` and `--after` context for the question, then stop if that hit is
  sufficient instead of automatically reopening the session.
- Every hit prints `id` and `idx`. If its bounded context is insufficient, use
  `--session ID --at IDX` rather than re-running several wider synonym searches.
- Once an ID is known, `--query TEXT --session ID` searches only that transcript. Use it to
  find a new evidence pointer without reopening global discovery or dumping a large skim.
- For scoped chronology, compare `total_message_matches` with `shown`. If matches were omitted,
  stay in the same session and reduce context or use `--sort oldest` before concluding.
- `--target-root` accepts only a configured transcript-store root. A thread's project/cwd is
  not a source root; with a DB session id, use `--skim ID` instead.
- `--target-type claude|codex` narrows by source; `--source` is its compatibility alias.

## Inspect one session

Use `--skim ID` for a bounded view of one session. Short sessions are returned losslessly
within `--max-chars`; long sessions preserve the head/tail and sample the middle. Increase
the aperture or use a shown message index with `--session ID --at IDX` when needed.

Add `--owner-operator` only when searching Owner Operator's own isolated transcripts, such as a prior scheduled run or prior Owner Operator conversation.

Use one primary mode: `--query`, `--skim ID`, or `--session ID --at IDX`. A query may add
`--session ID` as its explicit scope.

## Examples

Known id supplied by the caller:

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --skim 'SESSION_ID' --max-chars 12000"}
```

Distinctive anchor whose first hit may answer the question:

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --query 'ERR_PACKAGE_PATH_NOT_EXPORTED' --before 2 --after 5 --since 7d"}
```

Paraphrased question without an id; let rarity rank the candidate terms:

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --query 'rollout checkpoint reconciliation' --any --candidates --limit 8 --since 7d"}
```

Fuller context around a returned `id=... idx=...` pointer:

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --session 'SESSION_ID' --at MESSAGE_INDEX --before 3 --after 5"}
```

Find another fact inside an already selected session:

```json
{"command":"node \"$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs\" --query 'checkpoint reconciliation' --session 'SESSION_ID'"}
```
