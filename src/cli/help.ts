// `oo --help` and every noun's and verb's help, generated from the noun table so it cannot drift
// from the verbs it routes to. The Operator's system prompt embeds the whole tree
// (src/agent/agent.ts), so it stays deterministic and building it never touches the daemon.
import { OPERATION_NOUNS } from "./oo-args";
import { NOUNS } from "./operations";
import { nounHelp, verbHelp } from "./operations/operation";
import { SEARCH_USE_WHEN } from "./operations/search";

const NOUN_COLUMN = 18;

function nounLine(noun: (typeof OPERATION_NOUNS)[number]): string {
  const useWhen = noun === "search"
    ? `${SEARCH_USE_WHEN}; flags only, no verbs (\`oo search --help\` prints them)`
    : NOUNS[noun].useWhen;
  return `  ${`oo ${noun}`.padEnd(NOUN_COLUMN)} ${useWhen}`;
}

export function rootHelp(): string {
  return `Owner Operator (oo) — track and act on your local CLI agent sessions.

  oo                              embedded Pi interactive mode
  oo -p | --prompt "<text>"       one headless turn (prose on stdout, session id on stderr)
  oo --continue [-p "<text>"]     resume the most recent oo thread
  oo --session <id> [-p "<text>"] resume a specific oo thread
  oo --from-session <id>          record which coding session is calling
  oo doctor | status              effective workspace, resources, credentials, and gates
  oo daemon                       run the state-owning daemon
  oo --help | -h                  this help

Operations: which noun answers which question. Model-free; \`oo <noun> --help\` lists its verbs,
\`oo <noun> <verb> --help\` its flags, rules, and examples; every verb takes --json.
${OPERATION_NOUNS.map(nounLine).join("\n")}

Discovery: to find which session handled something, start from the index of every session's
titles and status-summary history, then take the ids it returns to the transcripts:
  oo db query "SELECT thread_id, version, topic, status_summary FROM thread_details
    WHERE topic LIKE '%<words>%' OR status_summary LIKE '%<words>%' ORDER BY thread_id, version"
  oo search --skim <thread_id>
Choose the shortest mode the known facts justify. After every result, answer if the
evidence suffices or reclassify: zero hits call for a broader route, several plausible sessions for
progressive discovery, one resolved id for direct retrieval. Do not run state and transcript
discovery in parallel merely to hedge.
  Direct       a stable session id or verbatim anchor such as an error, PR, filename, code symbol,
               or quoted phrase: search transcripts for it and stop when the bounded result answers.
  Indexed      state, repo, time, titles, and status-summary history are structured facts
               \`oo session-state\` and \`oo db\` answer. Metadata answers a metadata-only question;
               when exact changes, reasons, artifacts, or proof are requested, take a returned id to
               transcript search.
  Progressive  the target is ambiguous, paraphrased, or spread across plausible sessions: candidate
               discovery first through the title and summary index above, then inspect only
               candidates whose pointers remain relevant.
  Exhaustive   absence, completeness, or "every session" is part of the claim: search an explicit
               time, source, and namespace scope, broaden grounded terms as needed, and qualify the
               answer by the coverage actually inspected.
Questions or claims about prior Owner Operator interactions (what "we" discussed, recurring
feedback, behavior over time, bounded retrospectives) are transcript history. Unless explicitly
limited to this conversation, search transcripts before answering; the current chat supplies
anchors, not the corpus. Search Owner Operator history alone only when the requested corpus is
explicitly Owner Operator only. Preserve the searched time and namespace scope, and distinguish
recurring cross-session evidence from one-offs.
For multi-session comparisons, locate each endpoint independently, retrieve direct evidence from
each resolved id, order it by timestamp, and preserve which source made each claim. Repo and topic
labels are clues, not exact identity. Retain decision-critical literals: ids, PR numbers, errors,
counts, timings.

Calling from another coding session: Codex, Claude Code, and Cursor sessions identify themselves.
An OpenCode session passes --from-session <its id> on every call that takes it, or exports
OO_FROM_SESSION once. The caller is recorded as provenance, excluded from its own searches, and
becomes the parent of the runs it delegates.

Model: imported or configured under OO_HOME/pi/settings.json`;
}

/** Every noun's help followed by each of its verbs' help, exactly as `oo <noun> [<verb>] --help`
 * prints them. `oo search` is left out: the session-search skill owns its flags. */
export function helpTree(): string {
  return [rootHelp(), ...Object.entries(NOUNS).flatMap(([nounName, noun]) => [
    nounHelp(nounName, noun),
    ...Object.entries(noun.verbs).map(([verbName, verb]) => verbHelp(nounName, verbName, verb)),
  ])].join("\n\n");
}
