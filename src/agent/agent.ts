// Owner Operator — shared agent core. One place builds the opinionated session (our
// prompt, skills, settings-driven model); frontends (CLI + pi interactive) run it.
// pi is the engine.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { resolveBackend } from "../gateway/client";
import { describeTable, listTables, runQuery } from "../gateway/query-db";
import { getCurrentSessionStateRows, type CurrentSessionStateRow } from "../gateway/session-state";
import { repoRoot } from "../shared/repo-root";
import { blacklistAwareFileToolsExtension } from "./privacy-tools";
import { withOoRenderers } from "../shared/oo-presentation";

export { repoRoot };

const MarkThreadDoneParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String({
    description: "Stable thread ids to mark done.",
  }))),
  indexes: Type.Optional(Type.Array(Type.Integer({
    minimum: 1,
    description: "Current visible row numbers.",
  }))),
  queries: Type.Optional(Type.Array(Type.String({
    description: "User-provided names, repos, or topic snippets to resolve against the current session state.",
  }))),
});

const unique = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];
const cleanIds = (ids: readonly string[] | undefined): string[] =>
  unique((ids ?? []).map((s) => s.trim()).filter(Boolean));
const cleanIndexes = (indexes: readonly number[] | undefined): number[] =>
  unique((indexes ?? []).filter((n) => Number.isInteger(n) && n > 0));
const cleanQueries = (queries: readonly string[] | undefined): string[] =>
  unique((queries ?? []).map((s) => s.trim()).filter(Boolean));
const haystack = (t: CurrentSessionStateRow): string =>
  [t.id, t.repo, t.app, t.topic, t.summary, t.nextSteps].filter(Boolean).join(" ").toLowerCase();

export const getCurrentSessionStateTool = defineTool({
  name: "get_current_session_state",
  label: "Get current session state",
  description:
    "Read the owner's current session state — the exact rows their widget shows: row " +
    "number, id, repo, topic, state, priority, next step.",
  parameters: Type.Object({}),
  async execute() {
    const threads = await getCurrentSessionStateRows();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ threads }, null, 2) }],
      details: { threads },
    };
  },
});

export const markThreadDoneTool = defineTool({
  name: "mark_thread_done",
  label: "Mark thread done",
  description:
    "Mark one or more threads in the current session state done, by stable id, visible row number, or name/topic query.",
  parameters: MarkThreadDoneParams,
  async execute(_id, params) {
    const directIds = cleanIds(params.ids);
    const indexes = cleanIndexes(params.indexes);
    const queries = cleanQueries(params.queries);
    const rows = indexes.length || queries.length ? await getCurrentSessionStateRows() : [];
    const byIndex = new Map(rows.map((t) => [t.index, t]));
    const indexTargets = indexes.map((n) => byIndex.get(n)).filter((t): t is CurrentSessionStateRow => !!t);
    const queryResults = queries.map((query) => {
      const q = query.toLowerCase();
      const matches = rows.filter((t) => haystack(t).includes(q));
      return { query, matches };
    });
    const queryTargets = queryResults
      .filter((r) => r.matches.length === 1)
      .map((r) => r.matches[0]);
    const ids = unique([...directIds, ...indexTargets.map((t) => t.id), ...queryTargets.map((t) => t.id)]);
    const missingIndexes = indexes.filter((n) => !byIndex.has(n));
    const unresolvedQueries = queryResults
      .filter((r) => r.matches.length !== 1)
      .map((r) => ({
        query: r.query,
        matches: r.matches.map((t) => ({ index: t.index, id: t.id, repo: t.repo, topic: t.topic })),
      }));

    const result = await (await resolveBackend()).markThreadsDone(ids);

    const marked = result.marked.map((t) => rows.find((row) => row.id === t.id) ?? {
      index: null,
      id: t.id,
      topic: t.topic,
      repo: t.repo,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ marked, missingIds: result.missingIds, missingIndexes, unresolvedQueries }, null, 2),
      }],
      details: { marked, missingIds: result.missingIds, missingIndexes, unresolvedQueries },
    };
  },
});

export interface OwnerOperatorSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelLabel: string;
}

export interface OwnerOperatorSessionOptions {
  ephemeral?: boolean;
  sessionManager?: SessionManager;
}

// The opinionated agent config, shared by every frontend so they can't drift: one prompt,
// one set of custom tools, one allowlist.
export const ownerOperatorPrompt = (): string =>
  readFileSync(join(repoRoot, "src", "prompts", "owner-operator.md"), "utf8");

// Every owner chat is saved (and labeled with its surface) like any other oo thread;
// `ephemeral` is the opt-out for tests that shouldn't leave files in OO_HOME.
export async function createOwnerOperatorSession(
  surface: "chat" | "interactive" = "chat",
  opts: OwnerOperatorSessionOptions = {},
): Promise<OwnerOperatorSession> {
  // Eval-only: OO_EVAL_BASELINE_PROMPT swaps the Operator for a naive session-search agent
  // — same binary, same model, same trace — so the eval's controlled arm differs from OO
  // by exactly its prompt and toolset (no DB/state tools). Product runs never set it.
  const baselinePrompt = process.env.OO_EVAL_BASELINE_PROMPT;
  const prompt = baselinePrompt ? readFileSync(baselinePrompt, "utf8") : ownerOperatorPrompt();
  const customTools = baselinePrompt ? [searchSessionsTool] : ownerOperatorCustomTools;
  const tools = baselinePrompt ? ["read", "search_sessions"] : ownerOperatorTools;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(repoRoot); // model from .pi/settings.json

  const loader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir: getAgentDir(),
    systemPromptOverride: () => prompt,
    appendSystemPromptOverride: () => [],
    // The repo's .agents/skills are script docs for headless callers and the poller; the
    // Operator's interface to those scripts is its typed tools, so none inject here.
    skillsOverride: ({ diagnostics }) => ({ skills: [], diagnostics }),
    extensionFactories: [blacklistAwareFileToolsExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: repoRoot,
    resourceLoader: loader,
    settingsManager,
    sessionManager: opts.sessionManager ?? (opts.ephemeral ? SessionManager.inMemory(repoRoot) : createOoSession(ooProvenance(surface))),
    authStorage,
    modelRegistry,
    customTools,
    tools,
  });

  // Extensions initialize their state on `session_start`, which pi's own modes emit via
  // bindExtensions — a raw createAgentSession never does. Without this, package tools
  // (schedule_prompt) execute against uninitialized state and crash. Ephemeral sessions
  // stay unbound so a triage/test session never runs a second scheduler against the same
  // job store. Pair with shutdownSessionExtensions before dispose.
  if (!opts.ephemeral) await session.bindExtensions({});

  return { session, modelLabel: readModelLabel() };
}

/** Extension teardown (session_shutdown: cron auto-cleanup, timer stops) — pi's modes emit
 * this on quit; surfaces holding a raw session must emit it themselves before dispose(). */
export async function shutdownSessionExtensions(session: OwnerOperatorSession["session"]): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } catch {
    // best-effort: never let extension teardown block exit
  }
}

function readModelLabel(): string {
  let modelLabel = "model from .pi/settings.json";
  try {
    const s = JSON.parse(readFileSync(join(repoRoot, ".pi", "settings.json"), "utf8"));
    if (s.defaultModel) modelLabel = [s.defaultProvider, s.defaultModel].filter(Boolean).join("/");
  } catch {
    // no project settings — fall back to pi defaults
  }
  return modelLabel;
}

// ---- Read-only skill tools -------------------------------------------------------
// Run the specific scan/search scripts (which only READ local session files, and enforce the
// privacy blacklist) instead of exposing a general shell. Fixed script path + typed args passed
// through execFile (no shell) = no arbitrary commands.
const execFileAsync = promisify(execFile);
const skillScript = (dir: string, file: string): string => join(repoRoot, ".agents", "skills", dir, file);

export const searchSessionsTool = defineTool({
  name: "search_sessions",
  label: "Search sessions",
  description:
    "Read local session transcripts, two modes. grep (query): find literal text or a regex " +
    "across transcripts, with bounded context messages around each hit. sample (sessionId): " +
    "return one session's opening N and most-recent N messages plus its topic and state. " +
    "Exactly one of query or sessionId. Read-only.",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "grep mode: literal text to find, or a JS regex when regex is true." })),
    sessionId: Type.Optional(Type.String({ description: "sample mode: session id (prefix ok) — returns the session's opening + most-recent messages." })),
    sample: Type.Optional(Type.Integer({ minimum: 1, maximum: 40, description: "sample mode: messages kept from each end of the session. Default 4." })),
    regex: Type.Optional(Type.Boolean({ description: "grep mode: treat query as a JavaScript regex." })),
    ownerOperator: Type.Optional(Type.Boolean({ description: "grep mode: search Owner Operator's own stored sessions under OO_HOME instead of the owner's coding sessions." })),
    targetType: Type.Optional(Type.String({ description: "grep mode: all (default) | claude | codex. Parser/type narrowing, not a folder selector." })),
    targetRoot: Type.Optional(Type.String({ description: "grep mode: configured transcript root to narrow to, preserving the parser mapping from the sources file." })),
    since: Type.Optional(Type.String({ description: "Window: today | 7d | YYYY-MM-DD. sample mode defaults to 7d." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "grep mode: max matching messages. Default 20." })),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "grep mode: context messages before each hit. Default 1." })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "grep mode: context messages after each hit. Default 1." })),
  }),
  async execute(_id, p) {
    if (!!p.query === !!p.sessionId) throw new Error("search_sessions needs exactly one of query (grep) or sessionId (sample)");

    if (p.sessionId) {
      const args = ["--thread", p.sessionId, "--sample", String(p.sample ?? 4), "--since", p.since || "7d"];
      const { stdout } = await execFileAsync(process.execPath, [skillScript("scan-active-transcripts", "scan-active-transcripts.mjs"), ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
      return { content: [{ type: "text" as const, text: stdout.trim() || "(no session matched that id in the window)" }], details: undefined };
    }

    const args = ["--query", p.query!];
    if (p.regex) args.push("--regex");
    if (p.since) args.push("--since", p.since);
    if (p.targetRoot) args.push("--target-root", p.targetRoot);
    args.push("--limit", String(p.limit ?? 20), "--before", String(p.before ?? 1), "--after", String(p.after ?? 1));
    let script = skillScript("sessions-grep", "sessions-grep.mjs");
    if (p.ownerOperator) {
      const ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator");
      const sourceFile = join(ooHome, "session-grep-sources.json");
      const ownerOperatorRoot = join(ooHome, "sessions");
      if (!existsSync(sourceFile)) {
        mkdirSync(ooHome, { recursive: true });
        writeFileSync(sourceFile, JSON.stringify([{ type: "pi", root: ownerOperatorRoot }], null, 2) + "\n");
      }
      script = skillScript("sessions-grep", "vendor/session-grep.mjs");
      args.push("--sources-file", sourceFile, "--target-root", ownerOperatorRoot);
    } else if (p.targetType) {
      args.push("--target-type", p.targetType);
    }
    const { stdout } = await execFileAsync(process.execPath, [script, ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return { content: [{ type: "text" as const, text: stdout.trim() || "(no matches)" }], details: undefined };
  },
});

export const queryDatabaseTool = defineTool({
  name: "query_database",
  label: "Query session database",
  description:
    "Run read-only SQL over the session state database (SQLite). Actions: list_tables " +
    "(table names + row counts), describe_table (columns + CREATE statement), query " +
    "(execute a SELECT; results capped at 200 rows). The connection is read-only; " +
    "write statements fail.",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("list_tables"), Type.Literal("describe_table"), Type.Literal("query")], {
      description: "list_tables | describe_table | query.",
    }),
    table: Type.Optional(Type.String({ description: "Table name, for describe_table." })),
    sql: Type.Optional(Type.String({ description: "SELECT statement, for query." })),
  }),
  async execute(_id, p) {
    const asText = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      details: undefined,
    });
    if (p.action === "list_tables") return asText(listTables());
    if (p.action === "describe_table") {
      if (!p.table) throw new Error("describe_table needs a table name");
      return asText(describeTable(p.table));
    }
    if (!p.sql) throw new Error("query needs a sql SELECT statement");
    return asText(runQuery(p.sql));
  },
});

// Each OO tool renders as a single compact line in the interactive surface (renderCall /
// renderResult are TUI-only — inert for the headless callers that consume ownerOperatorCustomTools).
export const ownerOperatorCustomTools = [
  withOoRenderers(getCurrentSessionStateTool, "session state"),
  withOoRenderers(markThreadDoneTool, "mark done", {
    summarizeCall: (a) =>
      [...(a.ids ?? []), ...(a.indexes ?? []), ...(a.queries ?? [])].slice(0, 3).join(", "),
  }),
  withOoRenderers(queryDatabaseTool, "database", { summarizeCall: (a) => a.action ?? "" }),
  withOoRenderers(searchSessionsTool, "search", {
    summarizeCall: (a) => (a.sessionId ? `#${a.sessionId}` : a.query ? `"${a.query}"` : ""),
  }),
];
// `read` is a blacklist-aware override registered by blacklistAwareFileToolsExtension —
// the one general file tool, for owner-directed lookups. Transcript access goes through
// search_sessions/query_database only (no grep/find/ls), so the no-raw-transcript-reads
// policy is structural. schedule_prompt comes from pi-schedule-prompt (.pi/settings.json
// "packages").
export const ownerOperatorTools = [
  "read",
  "get_current_session_state",
  "mark_thread_done",
  "query_database",
  "search_sessions",
  "schedule_prompt",
];

// ---- Where oo's own threads live, and how they're labeled ----------------------
// EVERY oo session persists under oo's OWN home, NEVER pi's default ~/.pi/agent/sessions,
// so the poller never scans oo's chatter as if it were one of the owner's coding sessions.
// This module owns that policy: callers build managers through the helpers below, which bake
// the dir in, instead of naming it themselves (pi silently falls back to its own dir when a
// manager isn't given one). Same OO_HOME base as the durable store (store.ts). All oo threads
// run with cwd = repoRoot, so continueRecent/list scope to them correctly within one dir.
//
// Every invocation stamps an `oo-provenance` custom entry (never sent to the LLM): WHICH
// surface, owner vs agent origin, the caller's cwd + repo, and — the audit trail — the
// calling coding session's id when the caller identifies itself (`--from-session` or
// OO_FROM_SESSION in the env). A resumed thread accrues one
// stamp per invocation, so "who touched this thread, from where" is greppable later.
const ooHome = (): string => process.env.OO_HOME ?? join(homedir(), ".owner-operator");
export const ooSessionsDir = (): string => join(ooHome(), "sessions");

export type OoSurface = "chat" | "interactive";
export interface OoProvenance {
  surface: OoSurface;
  origin: "owner" | "agent";
  callerCwd: string; // where the process was invoked from (the launcher doesn't cd)
  callerRepo: string; // basename of the caller's git repo, or of the cwd outside one
  fromSession?: string; // audit: the coding session that called us, when it says so
  ppid: number; // best-effort process audit (an agent shelling out shows as its shell)
}

export function ooProvenance(surface: OoSurface, fromSession?: string): OoProvenance {
  const cwd = process.cwd();
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const callerSession = fromSession ?? process.env.OO_FROM_SESSION ?? undefined;
  return {
    surface,
    origin: callerSession ? "agent" : "owner",
    callerCwd: cwd,
    callerRepo: basename((git.status === 0 && git.stdout.trim()) || cwd),
    fromSession: callerSession,
    ppid: process.ppid,
  };
}

export function stampProvenance(sm: SessionManager, p: OoProvenance): void {
  sm.appendCustomEntry("oo-provenance", p);
  if (!sm.getSessionName()) sm.appendSessionInfo(`${p.surface}${p.fromSession ? ` ← ${p.fromSession}` : ""} @ ${p.callerRepo}`);
}

/** A fresh oo thread, stamped with its surface + caller provenance. */
export function createOoSession(provenance: OoProvenance): SessionManager {
  const sm = SessionManager.create(repoRoot, ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}
/** Resume the most recent oo thread (or a fresh one if none); each resume re-stamps. */
export function continueOoSession(provenance: OoProvenance): SessionManager {
  const sm = SessionManager.continueRecent(repoRoot, ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}
/** List oo threads — for resolving a `--session <id>` reference. */
export const listOoSessions = () => SessionManager.list(repoRoot, ooSessionsDir());
/** Open a specific oo thread file (re-stamped by the caller), keeping oo's dir for /new or /fork. */
export function openOoSession(path: string, provenance: OoProvenance): SessionManager {
  const sm = SessionManager.open(path, ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}

export function lastAssistantText(session: OwnerOperatorSession["session"]): string {
  const msgs: any[] = (session as any).state?.messages ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "assistant");
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
  return m?.text ?? "";
}
