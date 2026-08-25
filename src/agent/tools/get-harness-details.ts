import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { AgentRunHarness } from "@owner-operator/core";
import {
  readHarnessDetails,
  type HarnessDetailsSnapshot,
  type ReadHarnessDetailsOptions,
} from "../../agent-runs/harness-details";

const HarnessSchema = Type.Union(
  Object.values(AgentRunHarness).map((harness) => Type.Literal(harness)),
  { description: "Harness to observe: claude-code | codex | cursor." },
);

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
      "allowance, not tokens or cost. includeBaselineCandidates also projects each unpinned ACP " +
      "session's current model and effort as an unsaved proposal. This tool reports facts and " +
      "does not choose a harness or model.",
    parameters: Type.Object({
      harnesses: Type.Optional(Type.Array(HarnessSchema, {
        description: "Limit the observation to these harnesses. Omit to observe all of them.",
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
