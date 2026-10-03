// `oo --help`, generated from the noun table so it cannot drift from the verbs it routes to. The
// Operator's system prompt embeds this exact text (src/agent/agent.ts), so it stays deterministic
// and building it never touches the daemon.
import { OPERATION_NOUNS } from "./oo-args";
import { NOUNS } from "./operations";
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
\`oo <noun> <verb> --help\` its flags and examples; every verb takes --json.
${OPERATION_NOUNS.map(nounLine).join("\n")}

Model: imported or configured under OO_HOME/pi/settings.json`;
}
