import { claudeHookFact, type HookFact } from "@owner-operator/core";

/** One harness's payload translator. Codex and OpenCode register here; the route does not change. */
export interface HookAdapter {
  source: string;
  app: string;
  adapt(body: Record<string, unknown>): HookFact | null;
}

export const HOOK_ADAPTERS: Record<string, HookAdapter> = {
  claude: { source: "claude", app: "Claude CLI", adapt: claudeHookFact },
};
