// Parse `oo`'s argv. The headless prompt is free-form natural language, so this is NOT a strict
// flag parser: it recognizes the few known flags/subcommands and leaves everything else as the
// prompt, so `oo what changed --since today` works instead of erroring on an unknown flag.
export interface OoArgs {
  help: boolean; // --help / -h (anywhere)
  daemon: boolean; // `oo daemon` (first token only)
  sessionState: boolean; // --session-state
  removedJson: boolean; // old --json spelling; fail fast before building a model session
  removedHeadlessSubcommand: boolean; // removed headless subcommand; fail fast before building a model session
  interactive: boolean; // -i / --interactive
  continue: boolean; // --continue / -c
  session?: string; // --session <id-or-path>
  missingSession: boolean;
  fromSession?: string; // --from-session <id>
  missingFromSession: boolean;
  prompt: string; // the free-form headless prompt ("" → interactive REPL)
}

const REMOVED_HEADLESS_SUBCOMMANDS = new Set([
  ["one", "shot"].join("-"),
  ["one", "shot"].join(""),
]);

export function parseOoArgs(argv: readonly string[]): OoArgs {
  const rest: string[] = [];
  let session: string | undefined;
  let fromSession: string | undefined;
  let cont = false;
  let sessionState = false;
  let removedJson = false;
  let removedHeadlessSubcommand = false;
  let interactive = false;
  let missingSession = false;
  let missingFromSession = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-state") sessionState = true;
    else if (a === "--json") removedJson = true;
    else if (REMOVED_HEADLESS_SUBCOMMANDS.has(a)) removedHeadlessSubcommand = true;
    else if (a === "-i" || a === "--interactive") interactive = true;
    else if (a === "--continue" || a === "-c") cont = true;
    else if (a === "--session") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        missingSession = true;
        if (value?.startsWith("--")) i--;
      } else {
        session = value;
      }
    } else if (a === "--from-session") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        missingFromSession = true;
        if (value?.startsWith("--")) i--;
      } else {
        fromSession = value;
      }
    }
    else rest.push(a);
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    daemon: argv[0] === "daemon",
    sessionState,
    removedJson,
    removedHeadlessSubcommand,
    interactive,
    continue: cont,
    session,
    missingSession,
    fromSession,
    missingFromSession,
    prompt: rest.join(" ").trim(),
  };
}
