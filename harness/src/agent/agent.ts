// Owner Operator — shared agent core. One place builds the opinionated session (our
// prompt, skills, settings-driven model); frontends (oo.ts plain, tui.ts branded) render it.
// pi is the engine.

import { readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";
import { displayTopic, numberThreads, toSidebarThreads, type SidebarThread, type Thread } from "@owner-operator/core";
import { resolveBackend } from "../gateway/client";
import { repoRoot } from "../shared/repo-root";

export { repoRoot };

// ---- Structured triage output -------------------------------------------------
// The model emits its thread triage as a tool call (structured JSON) instead of prose;
// the TUI renders the payload as cards. This is the "structured output, rendered
// differently" path — the model fills the fields, the surface decides how to show them.
const ThreadCard = Type.Object({
  id: Type.String({ description: "Stable session id — copy the `id` from the digest verbatim (lets the sidebar match this thread)" }),
  topic: Type.String({ description: "Short title of the SPECIFIC work — never repeat the repo or app name (the card shows both separately); spend the title on what's actually happening" }),
  priority: Type.Integer({ minimum: 1, maximum: 5, description: "Priority 5 (highest — needs the owner now) down to 1 (lowest)" }),
  summary: Type.String({ description: "One SHORT, scannable sentence on current state (≤ ~15 words) — the gist, not the full story" }),
  nextSteps: Type.String({ description: "One short clause: the concrete next action" }),
  repo: Type.String({ description: "Repo name" }),
  app: Type.String({ description: "App / GUI the session was made from" }),
  created: Type.String({ description: "Relative time created, e.g. '2 hours ago' (copy from the digest)" }),
  lastActive: Type.String({ description: "Relative time of the last message, e.g. 'just now' (copy from the digest)" }),
  diffAdded: Type.Optional(Type.Integer({ description: "Lines added — copy the +N from the digest's Diff line, only when present" })),
  diffDeleted: Type.Optional(Type.Integer({ description: "Lines deleted — copy the -N from the digest's Diff line, only when present" })),
  link: Type.Optional(Type.String({ description: "Deep link to open the session, if the digest gives one" })),
});
const PresentThreadsParams = Type.Object({ threads: Type.Array(ThreadCard) });
const MarkThreadDoneParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String({
    description: "Stable thread ids to mark done.",
  }))),
  indexes: Type.Optional(Type.Array(Type.Integer({
    minimum: 1,
    description: "Current visible sidebar row numbers.",
  }))),
  queries: Type.Optional(Type.Array(Type.String({
    description: "User-provided names, repos, or topic snippets to resolve against the current sidebar.",
  }))),
});

interface SidebarToolThread {
  index: number;
  id: string;
  repo: string;
  app: string;
  topic: string;
  status: SidebarThread["state"];
  priority: number | null;
  summary: string | null;
  nextSteps: string | null;
  lastActive: string;
}

// Tools go through the Backend seam — the daemon when one runs (single writer), the
// store directly otherwise. Same data either way; the tool can't tell and shouldn't.
async function getCurrentSidebarThreads(): Promise<SidebarToolThread[]> {
  const backend = await resolveBackend();
  const snapshot = (await backend.loadSnapshot()) ?? { polledAt: "", threads: [] };
  const rows = toSidebarThreads(snapshot, await backend.loadTriage());
  const numbered = numberThreads(rows);
  return [...numbered.byNum.entries()].map(([index, t]) => ({
    index,
    id: t.id,
    repo: t.repo,
    app: t.app,
    topic: displayTopic(t),
    status: t.state,
    priority: t.priority ?? null,
    summary: t.summary ?? null,
    nextSteps: t.nextSteps ?? null,
    lastActive: t.lastActive,
  }));
}

const unique = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];
const cleanIds = (ids: readonly string[] | undefined): string[] =>
  unique((ids ?? []).map((s) => s.trim()).filter(Boolean));
const cleanIndexes = (indexes: readonly number[] | undefined): number[] =>
  unique((indexes ?? []).filter((n) => Number.isInteger(n) && n > 0));
const cleanQueries = (queries: readonly string[] | undefined): string[] =>
  unique((queries ?? []).map((s) => s.trim()).filter(Boolean));
const haystack = (t: SidebarToolThread): string =>
  [t.id, t.repo, t.app, t.topic, t.summary, t.nextSteps].filter(Boolean).join(" ").toLowerCase();

export const getSidebarThreadsTool = defineTool({
  name: "get_sidebar_threads",
  label: "Get sidebar threads",
  description:
    "Read the current visible Owner Operator sidebar rows, including row number, id, repo, topic, status, priority, and next step.",
  promptSnippet: "get_sidebar_threads — read current visible sidebar rows with index, id, topic, status, priority, and next step",
  promptGuidelines: [
    "Use get_sidebar_threads when the owner asks what is in the sidebar or wants current visible sidebar context.",
  ],
  parameters: Type.Object({}),
  async execute() {
    const threads = await getCurrentSidebarThreads();
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
    "Mark one or more current sidebar threads done by stable id, visible sidebar index, or name/topic query.",
  promptSnippet: "mark_thread_done — set sidebar thread status to done by id, visible index, or name/topic query",
  promptGuidelines: [
    "Use mark_thread_done only when the owner asks to mark threads done/resolved/inactive.",
    "Use ids when known, indexes for visible row numbers, or queries for user-provided names/topics.",
  ],
  parameters: MarkThreadDoneParams,
  async execute(_id, params) {
    const sidebar = await getCurrentSidebarThreads();
    const byIndex = new Map(sidebar.map((t) => [t.index, t]));
    const indexTargets = cleanIndexes(params.indexes).map((n) => byIndex.get(n)).filter((t): t is SidebarToolThread => !!t);
    const queryResults = cleanQueries(params.queries).map((query) => {
      const q = query.toLowerCase();
      const matches = sidebar.filter((t) => haystack(t).includes(q));
      return { query, matches };
    });
    const queryTargets = queryResults
      .filter((r) => r.matches.length === 1)
      .map((r) => r.matches[0]);
    const ids = unique([...cleanIds(params.ids), ...indexTargets.map((t) => t.id), ...queryTargets.map((t) => t.id)]);
    const missingIndexes = cleanIndexes(params.indexes).filter((n) => !byIndex.has(n));
    const unresolvedQueries = queryResults
      .filter((r) => r.matches.length !== 1)
      .map((r) => ({
        query: r.query,
        matches: r.matches.map((t) => ({ index: t.index, id: t.id, repo: t.repo, topic: t.topic })),
      }));

    const result = await (await resolveBackend()).markThreadsDone(ids);

    const marked = result.marked.map((t) => sidebar.find((row) => row.id === t.id) ?? {
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

// The TypeBox schema above is the LLM's structured-output contract; the UI-independent data
// model lives in @owner-operator/core. They must agree — this fails to compile if they drift.
const _schemaMatchesContract: Thread = undefined as unknown as Static<typeof ThreadCard>;
void _schemaMatchesContract;
export type { Thread };

export const presentThreadsTool = defineTool({
  name: "present_threads",
  label: "Present threads",
  description:
    "Render the triaged active threads to the owner as structured cards. Call this " +
    "INSTEAD of writing the triage as prose. One entry per thread, ordered most-urgent first.",
  promptSnippet: "present_threads — render triaged active threads as cards (use instead of prose)",
  promptGuidelines: [
    "When presenting active-thread triage, ALWAYS call present_threads — never write the threads as prose, a list, or a table.",
  ],
  parameters: PresentThreadsParams,
  async execute(_id, params) {
    const n = params.threads.length;
    return { content: [{ type: "text" as const, text: `Rendered ${n} thread card(s) for the owner.` }], details: undefined };
  },
});

export interface OwnerOperatorSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  skills: Array<{ name: string }>;
  modelLabel: string;
}

// The opinionated agent config, shared by every frontend (plain oo, branded TUI, pi
// interactive) so they can't drift: one prompt, one set of custom tools, one allowlist.
export const ownerOperatorPrompt = (): string =>
  readFileSync(join(repoRoot, "harness", "prompts", "owner-operator.md"), "utf8");
export const ownerOperatorCustomTools = [presentThreadsTool, getSidebarThreadsTool, markThreadDoneTool];
// read-only + bash to run the skills, plus our structured-output/owner tools. (This is an
// allowlist, so custom tools must be listed or they would be disabled.) schedule_prompt comes
// from the pi-schedule-prompt package (.pi/settings.json "packages") — lets the owner say
// "re-triage every 15 min" or "remind me at 3pm"; jobs only fire while a session is open.
export const ownerOperatorTools = ["read", "grep", "find", "ls", "bash", "present_threads", "get_sidebar_threads", "mark_thread_done", "schedule_prompt"];

// Every owner chat is saved (and labeled with its surface) like any other oo thread;
// `ephemeral` is the opt-out for harness tests that shouldn't leave files in OO_HOME.
export async function createOwnerOperatorSession(
  surface: "chat" | "tui" = "chat",
  opts: { ephemeral?: boolean } = {},
): Promise<OwnerOperatorSession> {
  const prompt = ownerOperatorPrompt();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(repoRoot); // model from .pi/settings.json

  const loader = new DefaultResourceLoader({
    cwd: repoRoot,
    agentDir: getAgentDir(),
    systemPromptOverride: () => prompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { skills } = loader.getSkills();

  const { session } = await createAgentSession({
    cwd: repoRoot,
    resourceLoader: loader,
    settingsManager,
    sessionManager: opts.ephemeral ? SessionManager.inMemory(repoRoot) : createOoSession(ooProvenance(surface)),
    authStorage,
    modelRegistry,
    customTools: ownerOperatorCustomTools,
    tools: ownerOperatorTools,
  });

  // Extensions initialize their state on `session_start`, which pi's own modes emit via
  // bindExtensions — a raw createAgentSession never does. Without this, package tools
  // (schedule_prompt) execute against uninitialized state and crash. Ephemeral sessions
  // stay unbound so a triage/test session never runs a second scheduler against the same
  // job store. Pair with shutdownSessionExtensions before dispose.
  if (!opts.ephemeral) await session.bindExtensions({});

  return { session, skills, modelLabel: readModelLabel() };
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

// ---- Read-only skill tools for the headless agent channel ---------------------
// Run the specific scan/search scripts (which only READ local session files, and enforce the
// privacy blacklist) instead of exposing a general shell. Fixed script path + typed args passed
// through execFile (no shell) = no arbitrary commands.
const execFileAsync = promisify(execFile);
const skillScript = (dir: string, file: string): string => join(repoRoot, ".agents", "skills", dir, file);

export const scanSessionsTool = defineTool({
  name: "scan_sessions",
  label: "Scan sessions",
  description:
    "Compact digest of the owner's active local agent sessions — topic, resolved state, and a sample " +
    "of each thread's opening + most-recent messages. Read-only.",
  promptSnippet: "scan_sessions — digest of active sessions (topic, state, message samples)",
  promptGuidelines: ["Use scan_sessions for an overview of what's ongoing before reading individual session files."],
  parameters: Type.Object({
    since: Type.Optional(Type.String({ description: "Window: 24h | 7d | today | YYYY-MM-DD. Default today." })),
    sample: Type.Optional(Type.Integer({ minimum: 0, maximum: 40, description: "Messages kept per thread (first N + last N). Default 4." })),
    thread: Type.Optional(Type.String({ description: "Drill into ONE thread by id prefix; pair with a larger sample." })),
  }),
  async execute(_id, p) {
    const args = ["--since", p.since || "today", "--sample", String(p.sample ?? 4)];
    if (p.thread) args.push("--thread", p.thread);
    const { stdout } = await execFileAsync(process.execPath, [skillScript("get-active-threads", "get-active-threads.mjs"), ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return { content: [{ type: "text" as const, text: stdout.trim() || "(no active threads)" }], details: undefined };
  },
});

export const searchSessionsTool = defineTool({
  name: "search_sessions",
  label: "Search sessions",
  description:
    "Grep across the owner's local session transcripts, with bounded context around each hit. Read-only. " +
    "Set source to 'self' for SELF-REFLECTION: it searches your own past agent-to-agent threads " +
    "(kept in a separate directory, never mixed into the owner's sessions) — what you were asked " +
    "and answered in previous invocations.",
  promptSnippet: "search_sessions — grep session transcripts with context around each hit; source 'self' searches your own past threads (self-reflection)",
  promptGuidelines: [
    "Use search_sessions to find where something was discussed across sessions.",
    "Use search_sessions with source 'self' to recall your own previous answers across invocations (self-reflection) — 'self' is separate and never part of the default search.",
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Literal text to find, or a JS regex when regex is true." }),
    regex: Type.Optional(Type.Boolean({ description: "Treat query as a JavaScript regex." })),
    source: Type.Optional(Type.String({ description: "all (default: the owner's coding sessions) | claude | codex | self (oo's own past threads, every surface — self-reflection; never included in all)." })),
    surface: Type.Optional(Type.String({ description: "With source self: narrow to one oo surface — tui | chat | interactive | one-shot." })),
    since: Type.Optional(Type.String({ description: "Window: today | 7d | YYYY-MM-DD." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max matching messages. Default 20." })),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Context messages before each hit. Default 1." })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Context messages after each hit. Default 1." })),
  }),
  async execute(_id, p) {
    const args = ["--query", p.query];
    if (p.regex) args.push("--regex");
    if (p.source) args.push("--source", p.source);
    if (p.surface) args.push("--surface", p.surface);
    if (p.since) args.push("--since", p.since);
    args.push("--limit", String(p.limit ?? 20), "--before", String(p.before ?? 1), "--after", String(p.after ?? 1));
    const { stdout } = await execFileAsync(process.execPath, [skillScript("sessions-grep", "sessions-grep.mjs"), ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return { content: [{ type: "text" as const, text: stdout.trim() || "(no matches)" }], details: undefined };
  },
});

// ---- Neutral runtime for headless agent-to-agent use (`oo one-shot`) ----------
// pi's runPrintMode needs an AgentSessionRuntime (not the raw session createAgentSession
// returns), so we build one with pi's own factory — the same shape pi's main.js uses.
// This session is deliberately NOT the triage persona, and is read-only at the TOOL layer
// (no bash/shell) since it's an agent-facing channel: a neutral prompt, read-only tools only
// (file reads + the scan/search skills + get_sidebar_threads), and NO present_threads.
export const neutralAgentPrompt = (): string =>
  readFileSync(join(repoRoot, "harness", "prompts", "agent-channel.md"), "utf8");
export const neutralAgentTools = ["read", "grep", "find", "ls", "get_sidebar_threads", "scan_sessions", "search_sessions"];
export const neutralAgentCustomTools = [getSidebarThreadsTool, scanSessionsTool, searchSessionsTool];

// ---- Where oo's own threads live, and how they're labeled ----------------------
// EVERY oo session — owner surfaces (TUI, plain chat, pi interactive) and the agent channel
// (one-shot) — persists under oo's OWN home, NEVER pi's default ~/.pi/agent/sessions,
// so the poller never scans oo's chatter as if it were one of the owner's coding sessions.
// This module owns that policy: callers build managers through the helpers below, which bake
// the dir in, instead of naming it themselves (pi silently falls back to its own dir when a
// manager isn't given one). Same OO_HOME base as the durable store (store.ts). All oo threads
// run with cwd = repoRoot, so continueRecent/list scope to them correctly within one dir.
//
// Every invocation stamps an `oo-provenance` custom entry (never sent to the LLM): WHICH
// surface, owner vs agent origin, the caller's cwd + repo, and — the audit trail — the
// calling coding session's id when the caller identifies itself (`--from-session` on
// one-shot, or OO_FROM_SESSION in the env for any surface). A resumed thread accrues one
// stamp per invocation, so "who touched this thread, from where" is greppable later.
const ooHome = (): string => process.env.OO_HOME ?? join(homedir(), ".owner-operator");
export const ooSessionsDir = (): string => join(ooHome(), "sessions");

export type OoSurface = "tui" | "chat" | "interactive" | "one-shot";
export interface OoProvenance {
  surface: OoSurface;
  origin: "owner" | "agent"; // owner-facing surface vs the agent-to-agent channel
  callerCwd: string; // where the process was invoked from (the launcher doesn't cd)
  callerRepo: string; // basename of the caller's git repo, or of the cwd outside one
  fromSession?: string; // audit: the coding session that called us, when it says so
  ppid: number; // best-effort process audit (an agent shelling out shows as its shell)
}

export function ooProvenance(surface: OoSurface, fromSession?: string): OoProvenance {
  const cwd = process.cwd();
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return {
    surface,
    origin: surface === "one-shot" ? "agent" : "owner",
    callerCwd: cwd,
    callerRepo: basename((git.status === 0 && git.stdout.trim()) || cwd),
    fromSession: fromSession ?? process.env.OO_FROM_SESSION ?? undefined,
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

// `oo one-shot` passes a disk-backed manager (the helpers above) so the thread survives
// across invocations. In-memory is the safe default (used by tests) — it never touches
// pi's session dir.
export async function createNeutralAgentRuntime(sessionManager: SessionManager = SessionManager.inMemory(repoRoot)) {
  const authStorage = AuthStorage.create();
  const settingsManager = SettingsManager.create(repoRoot); // model from .pi/settings.json
  const prompt = neutralAgentPrompt();

  // The factory closes over our config; createAgentSessionRuntime calls it to build the
  // initial session and reuses it across any later /new or /switch.
  return createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        authStorage,
        settingsManager,
        resourceLoaderOptions: {
          systemPromptOverride: () => prompt,
          appendSystemPromptOverride: () => [],
          noExtensions: true, // headless: skip interactive extensions (e.g. the MCP statusbar adapter)
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: neutralAgentTools,
        customTools: neutralAgentCustomTools,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    },
    { cwd: repoRoot, agentDir: getAgentDir(), sessionManager },
  );
}

export function lastAssistantText(session: OwnerOperatorSession["session"]): string {
  const msgs: any[] = (session as any).state?.messages ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "assistant");
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
  return m?.text ?? "";
}
