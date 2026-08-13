import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { AgentRunHarness } from "@owner-operator/core";
import {
  readHarnessDetails,
  type HarnessDetails,
  type ReadHarnessDetailsOptions,
} from "../../agent-runs/harness-details";

const HarnessSchema = Type.Union(
  Object.values(AgentRunHarness).map((harness) => Type.Literal(harness)),
  { description: "Harness to observe: claude-code | codex | cursor." },
);

export interface GetHarnessDetailsResult {
  observedAt: string;
  ephemeral: true;
  details: HarnessDetails[];
}

/** Thin presentation adapter: it shapes the envelope and does no selection, ranking, or
 * interpretation of the observed facts. */
export function harnessDetailsResult(
  details: readonly HarnessDetails[],
  observedAt: string,
): GetHarnessDetailsResult {
  return { observedAt, ephemeral: true, details: [...details] };
}

export function createGetHarnessDetailsTool(
  options: { read?: (input: ReadHarnessDetailsOptions) => Promise<HarnessDetails[]> } = {},
) {
  const read = options.read ?? readHarnessDetails;
  return defineTool({
    name: "get_harness_details",
    label: "Get harness details",
    description:
      "Read what each delegation harness currently offers: its model catalog, the reasoning " +
      "levels each model supports, the subscription plan, and how much of each subscription " +
      "allowance window is spent. Facts are observed live and never cached, so the snapshot is " +
      "only true as of observedAt. null means the harness exposes no such fact (unknown); an " +
      "empty array means it was observed and there are none. Percentages are share of " +
      "subscription allowance, not tokens or cost. Set includeBaselineCandidates to also ask each " +
      "harness what model and effort it would choose for itself; that answer is a proposal only " +
      "and is never saved. This tool reports facts and does not choose a harness or model.",
    parameters: Type.Object({
      harnesses: Type.Optional(Type.Array(HarnessSchema, {
        description: "Limit the observation to these harnesses. Omit to observe all of them.",
      })),
      includeBaselineCandidates: Type.Optional(Type.Boolean({
        description:
          "Also start one throwaway unpinned session per harness to learn its self-selected model " +
          "and effort. Costs several seconds per harness. Default false.",
      })),
    }),
    async execute(_id, params) {
      const details = await read({
        ...(params.harnesses?.length ? { harnesses: params.harnesses as AgentRunHarness[] } : {}),
        ...(params.includeBaselineCandidates ? { includeBaselineCandidates: true } : {}),
      });
      const result = harnessDetailsResult(details, details[0]?.observedAt ?? new Date().toISOString());
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}

export const getHarnessDetailsTool = createGetHarnessDetailsTool();
