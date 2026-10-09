// `oo search --help`: every flag the wrapper accepts and how to search with them. The wrapper
// prints it, `oo search --help` prints it without the daemon, and the Operator's prompt embeds it
// through helpTree(), so every agent reads one copy.
export const SEARCH_HELP = `Usage: oo search (--query TEXT | --skim ID | --session ID --at INDEX) [options]

Privacy-aware transcript search, run by the daemon. Search transcripts only through \`oo search\`;
reading transcript files directly or calling the vendored primitive bypasses the privacy policy.
Discovery searches configured coding-agent stores plus Owner Operator history by default,
preserves each result's namespace and transcript format, and excludes the current Owner Operator
session and its external coding-agent caller when their stable ids are available. The query header
reports \`discovery_session_exclusions=applied:ID,...\` or \`unavailable\`, so prompt-echo risk is
explicit.

Modes (use one; a query may add --session ID as its scope):
  --query TEXT              literal search; the text may begin with dashes, such as --units
  --skim ID                 one session, bounded: short sessions whole, long ones head/tail kept
                            and the middle sampled
  --session ID --at INDEX   open the messages around one index from a hit's idx=
Query flags:
  --any                     match any word (whitespace or | delimit terms); rarest hits rank
                            first, per-word hit counts reported
  --candidates              group hits by session before limits; one best pointer per session
                            (only with --query)
  --regex                   treat --query as a JavaScript regex, case-insensitive unless
                            --case-sensitive; a leading (?i) is accepted
  --case-sensitive          exact case match
  --role user|assistant|all only that side of the conversation, default all
  --since today|Nd|DATE     only messages at or after this time
  --until today|Nd|DATE     upper bound, inclusive of the day or period named
  --before N / --after N    messages around each hit, default 1 (5 with --session/--at)
  --focus TEXT              with --session/--at, centre the preview on this text
  --sort newest|oldest|file output order, default newest (--any ranks by score first)
  --include-tools           also match tool calls and results
  --include-skill-bodies    also match injected skill documentation
Scope and output:
  --owner-operator          Owner Operator history only
  --target-type claude|codex|pi|all   one transcript format (--source is an alias)
  --target-root DIR         a configured transcript-store root; a project cwd is not one, so with
                            a DB session id use --skim ID instead
  --limit N                 max matching messages (sessions with --candidates), default 20
  --max-chars N             output budget, default 8000, minimum 500
  --json                    machine-readable results
  --from-session ID         the calling coding session, excluded from discovery

Choose the lightest mode:
  Known session          use its stable id directly: a scoped query for one fact, --skim for a
                         short conversation or narrative view, an anchored window for a known
                         message.
  Distinctive anchor     when the question holds a high-information literal (a CamelCase or
                         snake_case identifier, error code, path, PR number, or quoted phrase),
                         query that literal alone first with enough bounded context to test the
                         answer. Keep generic question words and grouped candidates out of it
                         until the result is ambiguous or insufficient; an unknown session id
                         alone is not ambiguity. If the hit supplies the evidence, stop. A prose
                         topic label is not a verbatim anchor merely because it is hyphenated;
                         treat paraphrasable wording as ambiguous.
  Ambiguous target       several independent lexical anchors with --any, grouped with
                         --candidates --limit 8, then drill into promising pointers.
  Exhaustive claim       explicit time and source scope. Put independent anchor variants into one
                         --any query and use its word_hits, match totals, and omissions as the
                         coverage report. Search again only when retrieved evidence grounds a new
                         term or the report shows incomplete coverage; then qualify any absence or
                         completeness claim.
Modes can change after a result: zero hits warrant reformulation, several plausible sessions
warrant candidates, a resolved id warrants scoped retrieval. They are not a mandatory
query, candidate, skim, window sequence.

Evidence rules:
  - Execution evidence: to establish what an agent actually read, called, changed, or verified,
    MUST use --include-tools and inspect the relevant calls and results. Conversation-only search
    cannot establish that an action did or did not occur. Tool results use the user role, not
    owner authorship; use --role all to see calls and results together. Message indexes change
    with this flag: keep it when following an id/idx into a scoped query, window, or skim.
  - Readable reasoning traces are searched by default; tool calls, tool results, and injected
    skill bodies only when requested.
  - Multi-word text is one literal phrase. Use --any when several independent terms should
    match. If the header reports literal_multiword=true, retry with --any instead of treating
    zero hits as absence.
  - Read the exclusion counters before concluding absence: tools_excluded=N calls for
    --include-tools when execution evidence is relevant; skill_excluded=N calls for
    --include-skill-bodies only when injected documentation is itself the target.
  - Prefer a recent --since window before broadening; use --until when the question names a
    closed period.
  - Use enough --before and --after context for the question, then stop when that hit suffices
    instead of automatically reopening the session.
  - Every hit prints id and idx. When its bounded context is insufficient, open
    --session ID --at IDX rather than re-running wider synonym searches.
  - Once an id is known, --query TEXT --session ID searches only that transcript, finding a new
    pointer without reopening global discovery or dumping a large skim.
  - For scoped chronology, compare total_message_matches with shown. If matches were omitted,
    stay in the session and reduce context or use --sort oldest before concluding.
  - --owner-operator only when the requested scope is explicitly Owner Operator's own
    transcripts, such as scheduled runs.

Examples:
  oo search --query 'KeyError: wind_gust_kph' --since 7d
  oo search --query 'event backbone queue' --any --candidates --limit 8
  oo search --skim <id>
  oo search --session <id> --at <idx> --include-tools`;
