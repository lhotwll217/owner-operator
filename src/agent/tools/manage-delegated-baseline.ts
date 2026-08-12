import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  AGENT_RUN_EFFORTS,
  AgentRunHarness,
  approveDelegatedBaseline,
  type AgentRunEffort,
  type DelegatedBaselineApproval,
} from "@owner-operator/core";
import { proposeDelegatedBaseline } from "../../agent-runs/launch-config";

const HarnessSchema = Type.Union(Object.values(AgentRunHarness).map((value) => Type.Literal(value)));
const EffortSchema = Type.Union(AGENT_RUN_EFFORTS.map((value) => Type.Literal(value)));

export interface ManageDelegatedBaselineOptions {
  propose?: typeof proposeDelegatedBaseline;
  approve?: (
    harness: AgentRunHarness,
    approval: DelegatedBaselineApproval,
  ) => ReturnType<typeof approveDelegatedBaseline>;
}

/** The only owner-facing write seam for delegated baselines. Proposal is deliberately read-only;
 * approval persists only the exact values in the call after the owner has accepted them. */
export function createManageDelegatedBaselineTool(options: ManageDelegatedBaselineOptions = {}) {
  const propose = options.propose ?? proposeDelegatedBaseline;
  const approve = options.approve ?? approveDelegatedBaseline;
  return defineTool({
    name: "manage_delegated_baseline",
    label: "Manage delegated baseline",
    description:
      "Propose or approve the model and nullable reasoning-effort baseline for one delegation " +
      "harness. Use propose for initial discovery and refresh; it starts an unpinned harness " +
      "session, compares its candidate with the approved baseline, and never saves. If discovery " +
      "fails, ask the owner to choose. Use approve only after the owner explicitly approves the " +
      "exact model and effort; declining needs no action and leaves the approved baseline unchanged.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("propose"), Type.Literal("approve")]),
      harness: HarnessSchema,
      model: Type.Optional(Type.String({ minLength: 1, description: "Exact harness model id approved by the owner." })),
      effort: Type.Optional(Type.Union([EffortSchema, Type.Null()], {
        description: "Exact approved effort, or null when the baseline has no effort intent.",
      })),
    }),
    async execute(_id, params) {
      if (params.action === "propose") {
        if (params.model !== undefined || params.effort !== undefined) {
          throw new Error("propose discovers an unpinned candidate; omit model and effort");
        }
        return result(await propose(params.harness as AgentRunHarness));
      }
      if (params.model === undefined) throw new Error("approve requires the exact owner-approved model");
      return result(approve(params.harness as AgentRunHarness, {
        model: params.model,
        effort: (params.effort ?? null) as AgentRunEffort | null,
      }));
    },
  });
}

function result(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

export const manageDelegatedBaselineTool = createManageDelegatedBaselineTool();
