import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 2_000;
const MODEL_LIST_MAX_PAGES = 100;

export interface CodexAppServerPayloads {
  account: unknown;
  rateLimits: unknown;
  models: unknown;
}

export interface CodexAppServerOptions {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  killGraceMs?: number;
}

interface JsonRpcResponse { id?: unknown; result?: unknown; error?: { message?: unknown } }
interface Client { request: (method: string, params?: unknown) => Promise<unknown> }

/** Private process/JSON-RPC client. The facade owns normalization; this module owns the child. */
export function readCodexAppServerPayloads(options: CodexAppServerOptions = {}): Promise<CodexAppServerPayloads> {
  return withServer(options, async (client) => ({
    account: await client.request("account/read"),
    rateLimits: await client.request("account/rateLimits/read"),
    models: await readAllModelPages(client),
  }));
}

async function readAllModelPages(client: Client): Promise<unknown> {
  const data: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const payload = await client.request("model/list", cursor ? { cursor } : {});
    const result = record(payload);
    if (!result || !Array.isArray(result.data)) return payload;
    data.push(...result.data);
    const nextCursor = text(result.nextCursor);
    if (!nextCursor) return { ...result, data, nextCursor: null };
    if (seen.has(nextCursor)) throw new Error(`codex model/list pagination loop at cursor ${nextCursor}`);
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`codex model/list exceeded ${MODEL_LIST_MAX_PAGES} pages`);
}

async function withServer<T>(options: CodexAppServerOptions, run: (client: Client) => Promise<T>): Promise<T> {
  const child = spawn(options.command ?? "codex", [...options.args ?? ["app-server"]], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`codex app-server exited (code ${code ?? "unknown"})`)));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcResponse;
    try { message = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(text(message.error.message) ?? "codex app-server error"));
    else entry.resolve(message.result);
  });
  const send = (payload: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  };
  const request = (method: string, params: unknown = {}): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }); });
  };
  try {
    return await withDeadline((async () => {
      await request("initialize", { clientInfo: { name: "owner-operator", title: "Owner Operator", version: "0.0.0" } });
      send({ method: "initialized", params: {} });
      return await run({ request });
    })(), options.timeoutMs ?? TIMEOUT_MS, "codex app-server timed out");
  } finally {
    lines.close();
    await terminate(child, options.killGraceMs ?? KILL_GRACE_MS);
  }
}

async function terminate(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  try { child.stdin.end(); } catch { /* already gone */ }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { child.kill(signal); } catch { return; }
    if (await settlesWithin(exited, graceMs)) return;
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
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
