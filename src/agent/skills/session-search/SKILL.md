---
name: session-search
description: Search coding-agent or Owner Operator session transcripts through Owner Operator's privacy-aware session-grep policy. Use when exact text, regex, transcript evidence, prior conversation details, or a bounded view of a known session is needed.
---

# Session search

Run the bundled privacy-aware helper through `bash`. Owner Operator's bash capability accepts the fixed command `session-search` and an explicit argument array. Do not read transcript files directly or call the vendored primitive.

```json
{"command":"session-search","args":["--query","TEXT","--since","7d"]}
```

## Find transcript evidence

- `--query TEXT` performs literal search; add `--regex` only when the user needs a pattern.
- Prefer a recent `--since` window before broadening.
- Use small `--before` and `--after` context, then summarize the relevant hit instead of pasting a transcript.
- Narrow with `--target-type` or `--target-root` only when the user supplied enough context.

## Inspect one session

Use `--skim ID` for a bounded view of one session. Increase `--max-chars` only when the default view is insufficient.

Add `--owner-operator` only when searching Owner Operator's own isolated transcripts, such as a prior scheduled run or prior Owner Operator conversation.

Use exactly one of `--query` or `--skim`.
