import { complete, type Context } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThreadDetails } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

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

/** One typed completion for a needs-you message; no tools and no agent loop. */
export async function enrichThread(sample: string): Promise<ThreadDetails> {
  const settings = SettingsManager.create(repoRoot);
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!provider || !modelId) throw new Error("Owner Operator model is not configured");
  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(authStorage);
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`configured model not found: ${provider}/${modelId}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const context: Context = {
    systemPrompt:
      "Extract the current handoff for one coding-agent thread. Return only JSON with " +
      "topic (short), summary (one sentence), nextSteps (the concrete owner action), and priority (1-5).",
    messages: [{ role: "user", content: sample, timestamp: Date.now() }],
  };
  const response = await complete(model, context, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxRetries: 2,
  });
  const text = response.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return parseDetails(text);
}
