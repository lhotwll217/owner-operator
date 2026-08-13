import { execFile } from "node:child_process";
import { cursorAgentBinaryPath } from "./acp-launcher";

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One observation of the first-party `cursor-agent` CLI. Each subcommand degrades on its own:
 * a failed read leaves its payload null and records a labeled error, so an unreadable catalog
 * cannot erase the plan or auth facts. */
export interface CursorCliPayloads {
  /** Parsed `about --format json` result, or null when unreadable. */
  about: unknown;
  /** Parsed `status --format json` result, or null when unreadable. */
  status: unknown;
  /** Raw `models` stdout (a plain-text catalog), or null when unreadable. */
  modelsText: string | null;
  errors: string[];
}

export interface CursorCliOptions {
  /** Injectable for tests; production resolves the local `cursor-agent` binary. */
  command?: string;
  timeoutMs?: number;
}

/** Private process client. The facade owns normalization; this module owns the child processes. */
export async function readCursorCliPayloads(options: CursorCliOptions = {}): Promise<CursorCliPayloads> {
  // Resolve once so a missing CLI is one clear error, not three duplicates.
  const command = options.command ?? cursorAgentBinaryPath();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const errors: string[] = [];
  const [about, status, modelsText] = await Promise.all([
    readJson(command, ["about", "--format", "json"], timeoutMs, errors),
    readJson(command, ["status", "--format", "json"], timeoutMs, errors),
    readText(command, ["models"], timeoutMs, errors),
  ]);
  return { about, status, modelsText, errors };
}

async function readText(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  errors: string[],
): Promise<string | null> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(command, [...args], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  } catch (error) {
    errors.push(`cursor-agent ${args[0]}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readJson(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  errors: string[],
): Promise<unknown> {
  const stdout = await readText(command, args, timeoutMs, errors);
  if (stdout === null) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    errors.push(`cursor-agent ${args[0]}: output is not JSON`);
    return null;
  }
}
