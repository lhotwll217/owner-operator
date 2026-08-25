import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { AGENT_RUN_EFFORTS, AgentRunHarness } from "@owner-operator/core";
import {
  assertUniqueHarnessInspections,
  readHarnessDetails,
  type HarnessDetailsSnapshot,
  type ReadHarnessDetailsOptions,
} from "../../agent-runs/harness-details";

const HarnessSchema = Type.Union(
  Object.values(AgentRunHarness).map((harness) => Type.Literal(harness)),
  { description: "Harness to observe: claude-code | codex | cursor." },
);
const EffortSchema = Type.Union([
  ...AGENT_RUN_EFFORTS.map((effort) => Type.Literal(effort)),
  Type.Null(),
], {
  description: "Exact reasoning effort, or explicit null when reasoning is part of the opaque model ID or has no separate selector.",
});

export type GetHarnessDetailsResult = HarnessDetailsSnapshot;

export interface GetHarnessDetailsToolOptions {
  read?: (input: ReadHarnessDetailsOptions) => Promise<HarnessDetailsSnapshot>;
}

export function createGetHarnessDetailsTool(options: GetHarnessDetailsToolOptions = {}) {
  const read = options.read ?? readHarnessDetails;
  return defineTool({
    name: "get_harness_details",
    label: "Get harness details",
    description:
      "Return one ephemeral, never-cached snapshot with separate preferences, ACP capabilities, " +
      "and provider account namespaces. Every supported harness capability is observed through " +
      "the real disposable ACP launch seam and includes complete configOptions plus exact ACPX, " +
      "adapter, backend, resolution-source, and observation-time provenance. null means unknown; " +
      "an empty array means observed-and-none. Account allowance percentages are subscription " +
      "allowance, not tokens or cost. preferences.content is raw owner-authored routing guidance; " +
      "its path, source, and migration/conflict error identify the resolved file without rewriting " +
      "its prose. Use harnesses for an ordinary current-state snapshot. Use inspect in a separate " +
      "call to verify one exact non-current or model-dependent candidate per harness with the " +
      "same apply-and-confirm behavior as delegated launch: the requested model is initialized " +
      "first, success has a matching confirmation and complete post-selection configOptions, and " +
      "failure is explicit with no fallback confirmation. Never treat a failed or mismatched " +
      "inspection as confirmation for another identity. includeBaselineCandidates also projects " +
      "each unpinned ACP session's current model and effort as an unsaved proposal. This tool " +
      "reports facts and does not choose a harness or model.",
    parameters: Type.Object({
      harnesses: Type.Optional(Type.Array(HarnessSchema, {
        description: "Limit the observation to these harnesses. Omit to observe all of them.",
      })),
      inspect: Type.Optional(Type.Array(Type.Object({
        harness: HarnessSchema,
        model: Type.String({ minLength: 1, description: "Exact opaque ACP model ID; pass it unchanged." }),
        effort: EffortSchema,
      }), {
        description:
          "Inspect one exact model and nullable effort per harness in a disposable session. " +
          "Each harness may appear once; explicit null and opaque compound model IDs are preserved. " +
          "An inspect-only call observes only those harnesses.",
      })),
      includeBaselineCandidates: Type.Optional(Type.Boolean({
        description:
          "Also project each already-opened unpinned capability session's self-selected model " +
          "and effort as an unsaved baseline candidate. Starts no additional session. Default false.",
      })),
    }),
    async execute(_id, params) {
      assertUniqueHarnessInspections(params.inspect ?? []);
      const details = await read({
        ...(params.harnesses?.length ? { harnesses: params.harnesses as AgentRunHarness[] } : {}),
        ...(params.inspect?.length ? { inspect: params.inspect } : {}),
        ...(params.includeBaselineCandidates ? { includeBaselineCandidates: true } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
}

export const getHarnessDetailsTool = createGetHarnessDetailsTool();
