// Parse `oo one-shot`'s argv (after the launcher strips the subcommand). Same philosophy as
// oo-args: the prompt is free-form, so recognize the few session flags and leave the rest as
// the prompt instead of erroring on unknown tokens.
export interface OneShotArgs {
  continue: boolean; // --continue / -c — resume the most recent agent thread
  session?: string; // --session <id-or-path> — resume a specific thread
  fromSession?: string; // --from-session <id> — audit: the coding session making this call
  prompt: string; // the free-form prompt ("" → usage error)
}

export function parseOneShotArgs(argv: readonly string[]): OneShotArgs {
  const rest: string[] = [];
  let cont = false;
  let session: string | undefined;
  let fromSession: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--continue" || a === "-c") cont = true;
    else if (a === "--session") session = argv[++i]; // undefined when the value is missing
    else if (a === "--from-session") fromSession = argv[++i];
    else rest.push(a);
  }
  return { continue: cont, session, fromSession, prompt: rest.join(" ").trim() };
}
