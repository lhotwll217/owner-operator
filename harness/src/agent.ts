// Owner Operator — shared agent core. One place builds the opinionated session (our
// prompt, skills, settings-driven model); frontends (oo.ts plain, tui.ts branded) render it.
// pi is the engine.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");

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
    tools: ["read", "grep", "find", "ls", "bash"], // read-only + bash to run the skills
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
