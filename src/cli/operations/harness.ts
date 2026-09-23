import { AgentRunHarness, isAgentRunEffort, type AgentRunEffort, type HarnessDetailsRequest } from "@owner-operator/core";
import type { HarnessDetailsSnapshot } from "../../agent-runs/harness-details";
import { emit, gateway, UsageError, type Noun } from "./operation";

const HARNESSES = Object.values(AgentRunHarness) as string[];

function harnessId(value: string): AgentRunHarness {
  if (!HARNESSES.includes(value)) throw new UsageError(`unknown harness "${value}"; supported: ${HARNESSES.join(", ")}`);
  return value as AgentRunHarness;
}

/** `<harness>:<model>[:<effort>]`. Model ids are opaque and may contain colons, so only a final
 * segment that names an effort (or `null`) is read as the effort; an omitted effort is null. */
function parseInspection(spec: string): NonNullable<HarnessDetailsRequest["inspect"]>[number] {
  const [harness, ...rest] = spec.split(":");
  const last = rest.at(-1);
  const effortGiven = rest.length > 1 && (last === "null" || isAgentRunEffort(last));
  const model = (effortGiven ? rest.slice(0, -1) : rest).join(":");
  if (!model) throw new UsageError(`--inspect ${spec}: expected <harness>:<model>[:<effort>]`);
  return {
    harness: harnessId(harness!),
    model,
    effort: effortGiven && last !== "null" ? last as AgentRunEffort : null,
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

export const harness: Noun = {
  summary: "what each delegation harness offers right now (POST /harness-details)",
  verbs: {
    details: {
      summary: "one ephemeral snapshot: preferences, ACP capabilities, and account allowance",
      options: {
        harness: { type: "string", multiple: true, help: `limit to a harness (repeatable): ${HARNESSES.join(", ")}` },
        inspect: { type: "string", multiple: true, help: "confirm <harness>:<model>[:<effort>] in a disposable session (repeatable)" },
      },
      async run({ values, json }) {
        const harnesses = ((values.harness ?? []) as string[]).map(harnessId);
        const inspect = ((values.inspect ?? []) as string[]).map(parseInspection);
        const snapshot = await (await gateway()).harnessDetails({
          ...(harnesses.length ? { harnesses } : {}),
          ...(inspect.length ? { inspect } : {}),
        }) as HarnessDetailsSnapshot;
        emit(json, snapshot, () => renderSnapshot(snapshot));
        return 0;
      },
    },
  },
};
