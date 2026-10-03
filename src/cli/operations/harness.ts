import {
  AGENT_RUN_EFFORTS,
  AgentRunHarness,
  isAgentRunEffort,
  type AgentRunEffort,
  type DelegatedBaseline,
  type HarnessDetailsRequest,
} from "@owner-operator/core";
import type { HarnessDetailsSnapshot } from "../../agent-runs/harness-details";
import type { DelegatedBaselineProposal } from "../../agent-runs/launch-config";
import { emit, gateway, UsageError, type Noun } from "./operation";

const HARNESSES = Object.values(AgentRunHarness) as string[];

function harnessId(value: string): AgentRunHarness {
  if (!HARNESSES.includes(value)) throw new UsageError(`unknown harness "${value}"; supported: ${HARNESSES.join(", ")}`);
  return value as AgentRunHarness;
}

/** `<harness>:<model>[:<effort>]`. Model ids are opaque and may contain colons, so only a final
 * segment that names an effort (or `none`/`null`) is read as the effort; an omitted effort is null. */
function parseInspection(spec: string): NonNullable<HarnessDetailsRequest["inspect"]>[number] {
  const [harness, ...rest] = spec.split(":");
  const last = rest.at(-1);
  const nullEffort = last === "none" || last === "null";
  const effortGiven = rest.length > 1 && (nullEffort || isAgentRunEffort(last));
  const model = (effortGiven ? rest.slice(0, -1) : rest).join(":");
  if (!model) throw new UsageError(`--inspect ${spec}: expected <harness>:<model>[:<effort>]`);
  return {
    harness: harnessId(harness!),
    model,
    effort: effortGiven && !nullEffort ? last as AgentRunEffort : null,
  };
}

function renderSnapshot(snapshot: HarnessDetailsSnapshot): string {
  const lines = [`observed ${snapshot.observedAt}`];
  for (const row of snapshot.capabilities.harnesses) {
    const adapter = row.runtime?.adapter;
    lines.push("", `${row.harness}${adapter && "packageName" in adapter ? ` · ${adapter.packageName}@${adapter.packageVersion}` : ""}`);
    if (row.error) lines.push(`  error: ${row.error}`);
    const models = row.session?.models;
    if (models) {
      lines.push(`  current model: ${models.currentModelId ?? "unknown"}`);
      lines.push(`  models: ${models.availableModelIds?.join(", ") ?? "unknown"}`);
    }
    const candidate = row.baselineCandidate;
    if (candidate) {
      lines.push(`  baseline candidate: ${candidate.model ?? "unknown"} effort=${candidate.effort ?? "null"}${candidate.availableEfforts ? ` (efforts: ${candidate.availableEfforts.join(", ")})` : ""}`);
    }
    if (row.requestedInspection) {
      lines.push(`  inspected ${row.requestedInspection.model} effort=${row.requestedInspection.effort ?? "null"}: ${row.confirmation ? "confirmed" : "not confirmed"}`);
    }
    const account = snapshot.account.find((entry) => entry.harness === row.harness);
    if (account?.account?.plan) lines.push(`  plan: ${account.account.plan}`);
    for (const window of account?.allowanceWindows ?? []) {
      lines.push(`  allowance ${window.label ?? window.id}: ${window.usedPercent}% used`);
    }
  }
  if (snapshot.unknowns.length) lines.push("", `unknown: ${snapshot.unknowns.map((unknown) => `${unknown.harness ? `${unknown.harness} ` : ""}${unknown.fact}`).join("; ")}`);
  return lines.join("\n");
}

function identity(baseline: { model: string | null; effort: string | null } | null): string {
  return baseline ? `${baseline.model} effort=${baseline.effort ?? "null"}` : "none";
}

export const harness: Noun = {
  summary: "what each delegation harness offers right now, and its owner-approved default model and effort",
  useWhen: "which harnesses, models, and efforts are available before delegating, or proposing and approving a harness's default model and effort",
  verbs: {
    details: {
      summary: "one ephemeral snapshot: preferences, ACP capabilities, and account allowance",
      examples: [
        "oo harness details",
        "oo harness details --harness codex --harness claude-code --json",
        "oo harness details --harness codex --inspect codex:<model>:high",
      ],
      options: {
        harness: { type: "string", multiple: true, help: `limit to a harness (repeatable): ${HARNESSES.join(", ")}` },
        inspect: { type: "string", multiple: true, help: "confirm <harness>:<model>[:<effort|none>] in a disposable session (repeatable)" },
        "baseline-candidates": { type: "boolean", help: "also project each opened unpinned session's self-selected model and effort as an unsaved candidate" },
      },
      async run({ values, json }) {
        const harnesses = ((values.harness ?? []) as string[]).map(harnessId);
        const inspect = ((values.inspect ?? []) as string[]).map(parseInspection);
        const snapshot = await (await gateway()).harnessDetails({
          ...(harnesses.length ? { harnesses } : {}),
          ...(inspect.length ? { inspect } : {}),
          ...(values["baseline-candidates"] ? { includeBaselineCandidates: true } : {}),
        }) as HarnessDetailsSnapshot;
        await emit(json, snapshot, () => renderSnapshot(snapshot));
        return 0;
      },
    },
    propose: {
      args: "<harness>",
      summary: "what the harness would choose unpinned, against the approved default; never saves (POST /harness-baseline/propose)",
      minPositionals: 1,
      examples: [
        "oo harness propose codex",
        "oo harness propose claude-code --json",
      ],
      async run({ positionals: [name], json }) {
        const proposal = await (await gateway()).proposeBaseline(harnessId(name!)) as DelegatedBaselineProposal;
        await emit(json, proposal, () => [
          `${proposal.harness}`,
          `  approved:  ${identity(proposal.approved)}`,
          `  candidate: ${proposal.error ? `none (${proposal.error})` : identity(proposal.candidate)}`,
          ...(proposal.candidate?.availableEfforts ? [`  efforts:   ${proposal.candidate.availableEfforts.join(", ")}`] : []),
          `  differs:   ${proposal.differs}`,
        ].join("\n"));
        return 0;
      },
    },
    approve: {
      args: "<harness>",
      summary: "save the exact model and effort the owner approved as the harness default (POST /harness-baseline/approve)",
      minPositionals: 1,
      options: {
        model: { type: "string", help: "the exact model id the owner approved (required)" },
        effort: { type: "string", help: `the approved effort (required): ${AGENT_RUN_EFFORTS.join(", ")}, or none for no effort` },
      },
      examples: [
        "oo harness approve codex --model <model> --effort medium",
        "oo harness approve claude-code --model <model> --effort none --json",
      ],
      async run({ values, positionals: [name], json }) {
        const target = harnessId(name!);
        const model = values.model;
        if (typeof model !== "string" || !model.trim()) throw new UsageError("--model is required: the exact owner-approved model id");
        const effort = values.effort;
        if (effort !== "none" && !isAgentRunEffort(effort)) {
          throw new UsageError(`--effort is required: ${AGENT_RUN_EFFORTS.join(", ")}, or none`);
        }
        const baseline: DelegatedBaseline = await (await gateway()).approveBaseline(target, {
          model,
          effort: effort === "none" ? null : effort,
        });
        await emit(json, baseline, () => `approved ${target}: ${identity(baseline)}`);
        return 0;
      },
    },
  },
};
