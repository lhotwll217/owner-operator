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
import type { Thread } from "@owner-operator/core";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

// ---- Structured triage output -------------------------------------------------
// The model emits its thread triage as a tool call (structured JSON) instead of prose;
// the TUI renders the payload as cards. This is the "structured output, rendered
// differently" path — the model fills the fields, the surface decides how to show them.
const ThreadCard = Type.Object({
  topic: Type.String({ description: "Short title of what the thread is about" }),
  priority: Type.Integer({ minimum: 1, maximum: 5, description: "Priority 5 (highest — needs the operator now) down to 1 (lowest)" }),
  summary: Type.String({ description: "One sentence on what has generally happened / current state" }),
  nextSteps: Type.String({ description: "One short clause: the concrete next action" }),
  repo: Type.String({ description: "Repo name" }),
  app: Type.String({ description: "App / GUI the session was made from" }),
  created: Type.String({ description: "Relative time created, e.g. '2 hours ago' (copy from the digest)" }),
  lastActive: Type.String({ description: "Relative time of the last message, e.g. 'just now' (copy from the digest)" }),
  link: Type.Optional(Type.String({ description: "Deep link to open the session, if the digest gives one" })),
});
const PresentThreadsParams = Type.Object({ threads: Type.Array(ThreadCard) });

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
    customTools: [presentThreadsTool],
    // read-only + bash to run the skills, plus our structured-output tool. (This is an
    // allowlist, so present_threads must be listed or it would be disabled.)
    tools: ["read", "grep", "find", "ls", "bash", "present_threads"],
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
