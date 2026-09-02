import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { AGENT_RUN_EFFORTS, AgentRunHarness } from "@owner-operator/core";
import {
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
      "Observe current delegation-harness capabilities, provider accounts, and owner preferences " +
      "in one ephemeral, never-cached snapshot. Capability rows come from disposable ACP sessions " +
      "through the delegated-launch seam and include complete configOptions and runtime provenance. null " +
      "means unknown; an empty array means observed-and-none. Allowance percentages are shares " +
      "of subscription limits. This tool reports facts and does not choose or save a model or effort.",
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
