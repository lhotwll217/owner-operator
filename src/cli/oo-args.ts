// Parse `oo`'s top-level argv. A first token that names a reserved noun is an operation whose
// remaining argv belongs to that noun's verbs. Otherwise argv is a strict flag set: `-p` carries
// the headless prompt, and any other positional or unknown flag is a usage error.
import { parseArgs } from "node:util";

export const OPERATION_NOUNS = ["session-state", "runs", "schedules", "db", "harness", "search", "skill"] as const;
export type OperationNoun = (typeof OPERATION_NOUNS)[number];

export const isOperationNoun = (value: string | undefined): value is OperationNoun =>
  OPERATION_NOUNS.includes(value as OperationNoun);

export type OoCommand =
  | { kind: "help" }
  | { kind: "doctor" }
  | { kind: "daemon" }
  | { kind: "interactive" }
  | { kind: "operation"; noun: OperationNoun; argv: string[] }
  /** A plain oo conversation: one headless turn when `prompt` is set, else the readline REPL. */
  | { kind: "chat"; prompt?: string; continue: boolean; session?: string; fromSession?: string }
  | { kind: "usage-error"; message: string };

const REMOVED_HEADLESS_SUBCOMMANDS = new Set([
  ["one", "shot"].join("-"),
  ["one", "shot"].join(""),
]);

/** Spellings that used to work, each answered with its replacement. */
function removedSpelling(argv: readonly string[]): string | undefined {
  if (argv.includes("--session-state")) return "--session-state was replaced by `oo session-state list`";
  if (argv.includes("--done")) return "--done was replaced by `oo session-state done <id...>`";
  if (argv.includes("--json")) return "--json belongs to an operation verb, e.g. `oo session-state list --json`";
  if (REMOVED_HEADLESS_SUBCOMMANDS.has(argv[0] ?? "")) return "that headless subcommand was removed; use `oo -p \"question\"`";
  return undefined;
}

const VALUE_FLAGS = [
  ["--session", "--session needs an id or path"],
  ["--from-session", "--from-session needs an id"],
  ["--prompt", "-p/--prompt needs the prompt text"],
] as const;

export function parseOoArgs(argv: readonly string[]): OoCommand {
  const first = argv[0];
  if (isOperationNoun(first)) return { kind: "operation", noun: first, argv: argv.slice(1) };
  if (first === "doctor" || first === "status") return { kind: "doctor" };
  if (first === "daemon") return { kind: "daemon" };
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  const removed = removedSpelling(argv);
  if (removed) return { kind: "usage-error", message: removed };

  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        interactive: { type: "boolean", short: "i" },
        prompt: { type: "string", short: "p" },
        continue: { type: "boolean", short: "c" },
        session: { type: "string" },
        "from-session": { type: "string" },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = VALUE_FLAGS.find(([flag]) => message.includes(`${flag} <value>`) || message.includes(`'${flag}' argument`));
    return { kind: "usage-error", message: missing?.[1] ?? message };
  }
  const { values, positionals } = parsed;
  if (positionals.length) {
    const quoted = positionals.join(" ");
    return {
      kind: "usage-error",
      message: `unknown command "${positionals[0]}"; to ask Owner Operator, pass the prompt with -p: oo -p ${JSON.stringify(quoted)}`,
    };
  }
  for (const [flag, message] of VALUE_FLAGS) {
    const value = values[flag.slice(2) as "session" | "from-session" | "prompt"];
    if (value !== undefined && !value.trim()) return { kind: "usage-error", message };
  }
  if (values.interactive) {
    if (values.continue || values.session !== undefined || values["from-session"] !== undefined || values.prompt !== undefined) {
      return { kind: "usage-error", message: "-i/--interactive is only valid by itself; use bare `oo` for interactive mode" };
    }
    return { kind: "interactive" };
  }
  if (argv.length === 0) return { kind: "interactive" };
  return {
    kind: "chat",
    continue: values.continue === true,
    ...(values.prompt !== undefined ? { prompt: values.prompt.trim() } : {}),
    ...(values.session !== undefined ? { session: values.session } : {}),
    ...(values["from-session"] !== undefined ? { fromSession: values["from-session"] } : {}),
  };
}
