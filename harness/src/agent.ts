// Owner Operator — shared agent core. One place builds the opinionated session (our
// prompt, skills, settings-driven model); frontends (oo.ts plain, tui.ts branded) render it.
// pi is the engine.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { Type, type Static } from "@earendil-works/pi-ai";
import { displayTopic, numberThreads, toSidebarThreads, type SidebarThread, type Thread } from "@owner-operator/core";
import { resolveBackend } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

// ---- Structured triage output -------------------------------------------------
// The model emits its thread triage as a tool call (structured JSON) instead of prose;
// the TUI renders the payload as cards. This is the "structured output, rendered
// differently" path — the model fills the fields, the surface decides how to show them.
const ThreadCard = Type.Object({
  id: Type.String({ description: "Stable session id — copy the `id` from the digest verbatim (lets the sidebar match this thread)" }),
  topic: Type.String({ description: "Short title of the SPECIFIC work — never repeat the repo or app name (the card shows both separately); spend the title on what's actually happening" }),
  priority: Type.Integer({ minimum: 1, maximum: 5, description: "Priority 5 (highest — needs the operator now) down to 1 (lowest)" }),
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
    "Use get_sidebar_threads when the operator asks what is in the sidebar or wants current visible sidebar context.",
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
    "Use mark_thread_done only when the operator asks to mark threads done/resolved/inactive.",
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
    "Render the triaged active threads to the operator as structured cards. Call this " +
    "INSTEAD of writing the triage as prose. One entry per thread, ordered most-urgent first.",
  promptSnippet: "present_threads — render triaged active threads as cards (use instead of prose)",
  promptGuidelines: [
    "When presenting active-thread triage, ALWAYS call present_threads — never write the threads as prose, a list, or a table.",
  ],
  parameters: PresentThreadsParams,
  async execute(_id, params) {
    const n = params.threads.length;
    return { content: [{ type: "text" as const, text: `Rendered ${n} thread card(s) for the operator.` }], details: undefined };
  },
});

export interface OwnerOperatorSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  skills: Array<{ name: string }>;
  modelLabel: string;
}

export async function createOwnerOperatorSession(): Promise<OwnerOperatorSession> {
  const prompt = readFileSync(join(here, "..", "prompts", "owner-operator.md"), "utf8");

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
    sessionManager: SessionManager.inMemory(repoRoot),
    authStorage,
    modelRegistry,
    customTools: [presentThreadsTool, getSidebarThreadsTool, markThreadDoneTool],
    // read-only + bash to run the skills, plus our structured-output/operator tools.
    // (This is an allowlist, so custom tools must be listed or they would be disabled.)
    tools: ["read", "grep", "find", "ls", "bash", "present_threads", "get_sidebar_threads", "mark_thread_done"],
  });

  let modelLabel = "model from .pi/settings.json";
  try {
    const s = JSON.parse(readFileSync(join(repoRoot, ".pi", "settings.json"), "utf8"));
    if (s.defaultModel) modelLabel = [s.defaultProvider, s.defaultModel].filter(Boolean).join("/");
  } catch {
    // no project settings — fall back to pi defaults
  }

  return { session, skills, modelLabel };
}

export function lastAssistantText(session: OwnerOperatorSession["session"]): string {
  const msgs: any[] = (session as any).state?.messages ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "assistant");
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
  return m?.text ?? "";
}
