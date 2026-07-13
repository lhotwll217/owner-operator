import { completeSimple } from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThreadDetails } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

// Enrichment is a one-shot extraction, not a conversation: prefer a fast model over
// the interactive default, cap reasoning, and never let a call outlive the poll cadence.
const PREFERRED_MODELS: ReadonlyArray<readonly [provider: string, id: string]> = [
  ["openai-codex", "gpt-5.6-sol"],
];
const REASONING = "medium" as const;
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 45_000;

function parseDetails(text: string): ThreadDetails {
  const object = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!object) throw new Error("enrichment model returned no JSON object");
  const value = JSON.parse(object) as Record<string, unknown>;
  if (typeof value.nextSteps !== "string" || !value.nextSteps.trim()) {
    throw new Error("enrichment model omitted nextSteps");
  }
  if (value.topic !== undefined && typeof value.topic !== "string") throw new Error("invalid enrichment topic");
  if (value.summary !== undefined && typeof value.summary !== "string") throw new Error("invalid enrichment summary");
  if (value.priority !== undefined && (!Number.isInteger(value.priority) || Number(value.priority) < 1 || Number(value.priority) > 5)) {
    throw new Error("invalid enrichment priority");
  }
  return {
    ...(typeof value.topic === "string" ? { topic: value.topic.trim() } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary.trim() } : {}),
    nextSteps: value.nextSteps.trim(),
    ...(typeof value.priority === "number" ? { priority: value.priority } : {}),
  };
}

async function resolveModel(registry: ModelRegistry, settings: SettingsManager) {
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const candidates = [...PREFERRED_MODELS, ...(provider && modelId ? [[provider, modelId] as const] : [])];
  for (const [candidateProvider, candidateId] of candidates) {
    const model = registry.find(candidateProvider, candidateId);
    if (!model) continue;
    const auth = await registry.getApiKeyAndHeaders(model);
    if (auth.ok) return { model, auth };
  }
  throw new Error("no authenticated enrichment model available");
}

/** One typed completion for a needs-you message; no tools and no agent loop. */
export async function enrichThread(sample: string): Promise<ThreadDetails> {
  const settings = SettingsManager.create(repoRoot);
  const registry = ModelRegistry.create(AuthStorage.create());
  const { model, auth } = await resolveModel(registry, settings);

  const response = await completeSimple(model, {
    systemPrompt:
      "Extract the current handoff for one coding-agent thread. Return only JSON with " +
      "topic (short), summary (one sentence), nextSteps (the concrete owner action), and priority (1-5).",
    messages: [{ role: "user", content: sample, timestamp: Date.now() }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    reasoning: REASONING,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    maxRetries: 2,
  });
  if (response.stopReason === "error") {
    throw new Error(`enrichment model call failed: ${response.errorMessage ?? "unknown provider error"}`);
  }
  const text = response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return parseDetails(text);
}
