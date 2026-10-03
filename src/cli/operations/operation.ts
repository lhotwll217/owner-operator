// The shared shape of an `oo <noun> <verb>` operation: strict per-verb flags, `--json` on every
// verb, per-noun help as the discovery surface, and Gateway errors reported verbatim.
import { once } from "node:events";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { GatewayApi } from "@owner-operator/core";
import { GatewayRequestError } from "../../gateway/client";

export type VerbValues = Record<string, string | boolean | Array<string | boolean> | undefined>;

export interface VerbInput {
  values: VerbValues;
  positionals: string[];
  json: boolean;
}

export interface Verb {
  /** Arguments after the verb name, e.g. `<id...>`. */
  args?: string;
  summary: string;
  /** Verb flags other than the shared --json/--help; each carries its help line. */
  options?: Record<string, ParseArgsOptionsConfig[string] & { help: string }>;
  /** Number of required positionals; extra positionals are an error unless `variadic`. */
  minPositionals?: number;
  variadic?: boolean;
  /** Complete invocations, each starting `oo <noun> <verb>`; help shows them under Examples. */
  examples: string[];
  /** Returns the process exit code. */
  run(input: VerbInput): Promise<number>;
}

export interface Noun {
  summary: string;
  /** The questions this noun answers; root help routes by it. */
  useWhen: string;
  verbs: Record<string, Verb>;
}

export class UsageError extends Error {}

const SHARED_OPTIONS: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function optionLabel(name: string, option: ParseArgsOptionsConfig[string]): string {
  const flag = `${option.short ? `-${option.short}, ` : ""}--${name}`;
  return option.type === "string" ? `${flag} <value>` : flag;
}

export function verbHelp(nounName: string, verbName: string, verb: Verb): string {
  const lines = [`oo ${nounName} ${verbName}${verb.args ? ` ${verb.args}` : ""} [--json]`, "", `  ${verb.summary}`];
  lines.push("", "Flags:");
  for (const [name, option] of Object.entries(verb.options ?? {})) {
    lines.push(`  ${optionLabel(name, option).padEnd(28)} ${option.help}`);
  }
  lines.push("  --json                       machine-readable output");
  lines.push("", "Examples:", ...verb.examples.map((example) => `  ${example}`));
  return lines.join("\n");
}

export function nounHelp(nounName: string, noun: Noun): string {
  const rows = Object.entries(noun.verbs).map(([name, verb]) =>
    `  ${`${name}${verb.args ? ` ${verb.args}` : ""}`.padEnd(30)} ${verb.summary}`);
  return [
    `oo ${nounName} — ${noun.summary}`,
    "",
    `Use when: ${noun.useWhen}`,
    "",
    "Verbs:",
    ...rows,
    "",
    `Every verb accepts --json. \`oo ${nounName} <verb> --help\` shows its flags and examples.`,
  ].join("\n");
}

/** Run one noun's verb and return the exit code. Usage mistakes exit 2, operation failures 1. */
export async function runNoun(nounName: string, noun: Noun, argv: readonly string[]): Promise<number> {
  const [verbName, ...rest] = argv;
  if (verbName === undefined || verbName === "--help" || verbName === "-h") {
    process.stdout.write(`${nounHelp(nounName, noun)}\n`);
    return 0;
  }
  const verb = Object.hasOwn(noun.verbs, verbName) ? noun.verbs[verbName] : undefined;
  if (!verb) {
    process.stderr.write(`oo ${nounName}: unknown verb "${verbName}"\n\n${nounHelp(nounName, noun)}\n`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: { ...SHARED_OPTIONS, ...verb.options },
    });
  } catch (error) {
    process.stderr.write(`oo ${nounName} ${verbName}: ${(error as Error).message}\n\n${verbHelp(nounName, verbName, verb)}\n`);
    return 2;
  }
  if (parsed.values.help) {
    process.stdout.write(`${verbHelp(nounName, verbName, verb)}\n`);
    return 0;
  }
  const min = verb.minPositionals ?? 0;
  if (parsed.positionals.length < min || (!verb.variadic && parsed.positionals.length > min)) {
    process.stderr.write(`oo ${nounName} ${verbName}: expected ${verb.args ?? "no arguments"}\n\n${verbHelp(nounName, verbName, verb)}\n`);
    return 2;
  }
  const json = parsed.values.json === true;
  try {
    return await verb.run({ values: parsed.values, positionals: parsed.positionals, json });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`oo ${nounName} ${verbName}: ${error.message}\n\n${verbHelp(nounName, verbName, verb)}\n`);
      return 2;
    }
    reportFailure(error, json);
    return 1;
  }
}

/** Gateway failures surface the route's own error payload; `--json` keeps it structured. */
export function reportFailure(error: unknown, json: boolean): void {
  if (error instanceof GatewayRequestError) {
    process.stderr.write(json
      ? `${JSON.stringify({ status: error.status, ...(error.body && typeof error.body === "object" ? error.body : { error: error.message }) })}\n`
      : `oo: ${(error.body as { error?: unknown } | null)?.error ?? error.message}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(json ? `${JSON.stringify({ error: message })}\n` : `oo: ${message}\n`);
}

/** Print the route's payload unchanged under --json, else the verb's text rendering. */
export function emit(json: boolean, payload: unknown, text: () => string): Promise<void> {
  return writeOut(json ? `${JSON.stringify(payload, null, 2)}\n` : `${text()}\n`);
}

/** Write to stdout and wait for a full pipe to drain, so a slow reader slows the producer. */
export async function writeOut(text: string): Promise<void> {
  if (!process.stdout.write(text)) await once(process.stdout, "drain");
}

/** Resolve once everything queued on stdout and stderr has been handed to the OS. `process.exit`
 * discards queued pipe writes, so every exit after output waits for this first. */
export async function flushStdio(): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((resolve) => stream.write("", () => resolve()))));
}

/** The ready daemon's Gateway, starting the daemon when needed. The daemon owns every state
 * read and write; the CLI never opens the store. Under `OO_AGENT=1` (an Owner Operator agent's
 * bash) it only connects: ensureDaemon may replace a daemon whose fingerprint differs, and the
 * agent may be running inside that daemon (a scheduled run) or depend on it. */
export async function gateway(): Promise<GatewayApi> {
  const { resolveBackend } = await import("../../gateway/client");
  if (process.env.OO_AGENT === "1") {
    try {
      return await resolveBackend();
    } catch (cause) {
      throw new Error(await agentConnectFailure(), { cause });
    }
  }
  await (await import("../../daemon/ensure")).ensureDaemon();
  return resolveBackend();
}

/** Why an agent could not connect, so it asks the owner for the right thing: a dead daemon, one
 * still starting, or a live one this shell cannot reach (a sandbox, a stale token). */
async function agentConnectFailure(): Promise<string> {
  const probe = await (await import("../../gateway/client")).probeGateway();
  const notRunning = "the Owner Operator daemon is not running; agents do not start it. Ask the owner to start it (`oo status` shows its state).";
  if (!probe) return notRunning;
  const { pid, port, authToken } = probe.info;
  if (probe.kind === "reachable") return `the Owner Operator daemon (pid ${pid}) is still starting; retry shortly.`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return notRunning;
  }
  let detail = probe.cause instanceof Error ? probe.cause.message : String(probe.cause);
  const token = typeof authToken === "string" ? authToken.trim() : "";
  if (token) detail = detail.replaceAll(token, "[redacted]");
  return `the Owner Operator daemon (pid ${pid}, port ${port}) is running but unreachable from this shell: ${detail}. Agents do not restart it; ask the owner (\`oo status\` shows its state).`;
}
