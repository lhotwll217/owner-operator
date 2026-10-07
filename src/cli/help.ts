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
