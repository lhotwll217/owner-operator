import { SESSION_SEARCH_VALUE_FLAGS } from "../../session-search/flags.mjs";
import { callerSessionId } from "../../shared/caller-session";
import { gateway, reportFailure, writeOut } from "./operation";

export const SEARCH_SUMMARY = "privacy-aware transcript search, run by the daemon (POST /session-search)";

/** `oo search` forwards every argument except `--from-session` to the daemon's search wrapper;
 * the wrapper's flags (`oo search --help`) and output are the contract. */
export async function runSearch(argv: readonly string[]): Promise<number> {
  const args: string[] = [];
  let fromSession: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    if (SESSION_SEARCH_VALUE_FLAGS.has(argv[index]!)) {
      // A wrapper flag and its value pass through as a pair, whatever the value looks like.
      args.push(argv[index]!, ...(index + 1 < argv.length ? [argv[++index]!] : []));
    } else if (argv[index] === "--from-session") {
      fromSession = argv[++index];
      if (!fromSession || fromSession.startsWith("--")) {
        process.stderr.write("oo search: --from-session needs an id\n");
        return 2;
      }
    } else {
      args.push(argv[index]!);
    }
  }
  try {
    const result = await (await gateway()).sessionSearch({
      args,
      // Inside an Owner Operator bash tool, the product agent supplies both session ids.
      callerSessionId: fromSession?.trim() || process.env.OO_CALLER_SESSION_ID?.trim() || callerSessionId() || null,
      currentSessionId: process.env.OO_CURRENT_SESSION_ID?.trim() || null,
      cwd: process.cwd(),
    });
    await writeOut(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  } catch (error) {
    reportFailure(error, args.includes("--json"));
    return 1;
  }
}
