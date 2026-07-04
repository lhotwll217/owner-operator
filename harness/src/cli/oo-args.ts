// Parse `oo`'s argv. The one-shot prompt is free-form natural language, so this is NOT a strict
// flag parser: it recognizes the few known flags/subcommands and leaves everything else as the
// prompt, so `oo what changed --since today` works instead of erroring on an unknown flag.
export interface OoArgs {
  help: boolean; // --help / -h (anywhere)
  daemon: boolean; // `oo daemon` (first token only)
  json: boolean; // --json
  prompt: string; // the free-form one-shot prompt ("" → interactive REPL)
}

export function parseOoArgs(argv: readonly string[]): OoArgs {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    daemon: argv[0] === "daemon",
    json: argv.includes("--json"),
    prompt: argv.filter((a) => a !== "--json").join(" ").trim(),
  };
}
