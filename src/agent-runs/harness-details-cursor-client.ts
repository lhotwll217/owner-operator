import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ownerOperatorHome } from "../shared/paths";
import { cursorAgentBinaryPath } from "./acp-launcher";

const TIMEOUT_MS = 20_000;
const ACP_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One observation of the first-party `cursor-agent` surfaces. Each read degrades on its own:
 * a failed one leaves its payload null and records a labeled error, so an unreadable catalog
 * cannot erase the plan or auth facts. */
export interface CursorCliPayloads {
  /** Parsed `about --format json` result, or null when unreadable. */
  about: unknown;
  /** Parsed `status --format json` result, or null when unreadable. */
  status: unknown;
  /** The `models` object from a throwaway `cursor-agent acp` session — the launch-authoritative
   * catalog. The broader `cursor-agent models` account catalog uses different ids that a
   * delegated launch cannot select, so it is deliberately not read. */
  acpModels: unknown;
  errors: string[];
}

export interface CursorCliOptions {
  /** Injectable for tests; production resolves the local `cursor-agent` binary. */
  command?: string;
  timeoutMs?: number;
  acpTimeoutMs?: number;
}

/** Private process client. The facade owns normalization; this module owns the children. */
export async function readCursorCliPayloads(options: CursorCliOptions = {}): Promise<CursorCliPayloads> {
  // Resolve once so a missing CLI is one clear error, not three duplicates.
  const command = options.command ?? cursorAgentBinaryPath();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const errors: string[] = [];
  const [about, status, acpModels] = await Promise.all([
    readJson(command, ["about", "--format", "json"], timeoutMs, errors),
    readJson(command, ["status", "--format", "json"], timeoutMs, errors),
    readAcpSessionModels(command, options.acpTimeoutMs ?? ACP_TIMEOUT_MS, errors),
  ]);
  return { about, status, acpModels, errors };
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

/** Open one throwaway ACP session and return the advertised `models` object. The session runs
 * from OO_HOME, never the caller's working directory, and the server is terminated as soon as
 * session/new answers; nothing is prompted, so no turn is billed. */
async function readAcpSessionModels(
  command: string,
  timeoutMs: number,
  errors: string[],
): Promise<unknown> {
  const child = spawn(command, ["acp"], { cwd: ownerOperatorHome(), stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    return await withDeadline((async () => {
      const responses = new Map<number, (result: unknown) => void>();
      const failures: ((error: Error) => void)[] = [];
      const fail = (error: Error): void => { for (const reject of failures.splice(0)) reject(error); };
      child.on("error", fail);
      child.on("exit", (code) => fail(new Error(`cursor-agent acp exited (code ${code ?? "unknown"})`)));
      lines.on("line", (line) => {
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { message = JSON.parse(line) as typeof message; } catch { return; }
        if (typeof message.id !== "number") return;
        const settle = responses.get(message.id);
        if (!settle) return;
        responses.delete(message.id);
        if (message.error) fail(new Error(typeof message.error.message === "string" ? message.error.message : "cursor-agent acp error"));
        else settle(message.result);
      });
      const request = (id: number, method: string, params: unknown): Promise<unknown> =>
        new Promise((resolve, reject) => {
          responses.set(id, resolve);
          failures.push(reject);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      await request(1, "initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const session = await request(2, "session/new", { cwd: ownerOperatorHome(), mcpServers: [] });
      return session && typeof session === "object" ? (session as { models?: unknown }).models ?? null : null;
    })(), timeoutMs, "cursor-agent acp session timed out");
  } catch (error) {
    errors.push(`cursor-agent acp: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    lines.close();
    await terminate(child);
  }
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  try { child.stdin?.end(); } catch { /* already gone */ }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { child.kill(signal); } catch { return; }
    if (await settlesWithin(exited, KILL_GRACE_MS)) return;
  }
  await exited;
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })])
    .finally(() => clearTimeout(timer));
}
