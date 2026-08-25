import assert from "node:assert";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpRuntime, AcpRuntimeStatus } from "acpx/runtime";
import {
  ACP_CONFIG_OPTIONS_INVALID,
  AcpSelectionConfirmationError,
  advertisedSelectValues,
  applyAndConfirmAcpSelection,
  configOptionsFromStatus,
  type RequestedAcpSelection,
} from "./acp-session-selection";

const handle = { sessionKey: "selection-test", backend: "test", runtimeSessionName: "test" };
const requested: RequestedAcpSelection = { model: "claude-fable-5[1m]", effort: "xhigh" };

function select(
  id: string,
  currentValue: string,
  values: string[],
  category?: string,
): SessionConfigOption {
  return {
    id,
    name: id,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
    ...(category === undefined ? {} : { category }),
  };
}

function status(
  model: string | undefined = requested.model,
  options: unknown = [select("effort", "high", ["low", "high", "xhigh"], "thought_level")],
): AcpRuntimeStatus {
  return {
    ...(model === undefined ? {} : { models: { currentModelId: model, availableModelIds: [model] } }),
    details: { configOptions: options },
  };
}

function runtimeFor(params: {
  statuses: AcpRuntimeStatus[];
  calls?: string[];
  set?: (input: { key: string; value: string }) => void | Promise<void>;
}): AcpRuntime {
  let statusIndex = 0;
  return {
    getStatus: async () => {
      params.calls?.push("status");
      const result = params.statuses[Math.min(statusIndex, params.statuses.length - 1)];
      statusIndex += 1;
      if (!result) throw new Error("test status exhausted");
      return result;
    },
    setConfigOption: async ({ key, value }: { key: string; value: string }) => {
      params.calls?.push(`set:${key}:${value}`);
      await params.set?.({ key, value });
    },
  } as unknown as AcpRuntime;
}

async function rejectsSelection(
  work: Promise<unknown>,
  code: string,
  identity: RequestedAcpSelection = requested,
): Promise<AcpSelectionConfirmationError> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpSelectionConfirmationError, `expected ${code} selection failure`);
  assert.equal(caught.code, code);
  assert.deepEqual(caught.requested, identity);
  assert.match(caught.message, new RegExp(`model=${escapeRegex(JSON.stringify(identity.model))}`));
  assert.match(caught.message, new RegExp(`effort=${identity.effort === null ? "null" : escapeRegex(JSON.stringify(identity.effort))}`));
  return caught;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The narrow decoder preserves complete accepted objects and distinguishes absent from empty.
assert.equal(configOptionsFromStatus({}), null);
assert.equal(configOptionsFromStatus({ details: {} }), null);
const preserved = [
  select("mode", "agent", ["agent"]),
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    currentValue: "high",
    options: [
      { group: "ordinary", name: "Ordinary", options: [{ value: "low", name: "Low" }] },
      { group: "deep", name: "Deep", options: [{ value: "xhigh", name: "Xhigh" }] },
    ],
    description: "preserved",
    _meta: { future: true },
  } satisfies SessionConfigOption,
];
assert.equal(configOptionsFromStatus(status(requested.model, preserved)), preserved);
assert.deepEqual(advertisedSelectValues(preserved[1]!), ["low", "xhigh"]);
assert.deepEqual(configOptionsFromStatus(status(requested.model, [])), []);

for (const malformed of [
  null,
  {},
  [null],
  [{ id: "" }],
  [{ id: "effort", category: 1, type: "select", currentValue: "high", options: [] }],
  [{ id: "effort", type: "unknown", currentValue: "high", options: [] }],
  [{ id: "effort", type: "select", currentValue: true, options: [] }],
  [{ id: "effort", type: "select", currentValue: "high", options: {} }],
  [{ id: "effort", type: "select", currentValue: "high", options: [{}] }],
  [{ id: "effort", type: "select", currentValue: "high", options: [{ options: [{}] }] }],
  [{ id: "flag", type: "boolean", currentValue: "true" }],
]) {
  assert.throws(
    () => configOptionsFromStatus(status(requested.model, malformed)),
    (error: unknown) => error instanceof Error && error.message.includes(ACP_CONFIG_OPTIONS_INVALID),
    "malformed present config state fails closed",
  );
}

// Claude resolves category first and proves acknowledgement with exactly one status refresh.
{
  const calls: string[] = [];
  const confirmedOptions = [select("effort", "xhigh", ["low", "xhigh"], "thought_level")];
  const confirmed = await applyAndConfirmAcpSelection(
    runtimeFor({ statuses: [status(), status(requested.model, confirmedOptions)], calls }),
    handle,
    requested,
  );
  assert.deepEqual(calls, ["status", "set:effort:xhigh", "status"]);
  assert.deepEqual(confirmed, { model: requested.model, effort: "xhigh", configOptions: confirmedOptions });
}

// Codex resolves the bounded reasoning_effort fallback without requiring a category.
{
  const calls: string[] = [];
  const options = [select("reasoning_effort", "xhigh", ["high", "xhigh"]), select("unrelated_effort", "xhigh", ["xhigh"])];
  const confirmed = await applyAndConfirmAcpSelection(
    runtimeFor({ statuses: [status(requested.model, options), status(requested.model, options)], calls }),
    handle,
    requested,
  );
  assert.equal(confirmed.effort, "xhigh");
  assert.deepEqual(calls, ["status", "set:reasoning_effort:xhigh", "status"]);
}

// thought_level is the first bounded ID fallback when no category is advertised.
{
  const calls: string[] = [];
  const options = [
    select("reasoning_effort", "high", ["high", "xhigh"]),
    select("thought_level", "xhigh", ["high", "xhigh"]),
  ];
  await applyAndConfirmAcpSelection(
    runtimeFor({ statuses: [status(requested.model, options), status(requested.model, options)], calls }),
    handle,
    requested,
  );
  assert.deepEqual(calls, ["status", "set:thought_level:xhigh", "status"]);
}

// Cursor's compound model ID remains opaque; explicit null effort reads once and never sets.
{
  const cursorRequested = {
    model: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    effort: null,
  } as const;
  const calls: string[] = [];
  const options = [select("model", cursorRequested.model, [cursorRequested.model], "model")];
  const confirmed = await applyAndConfirmAcpSelection(
    runtimeFor({ statuses: [status(cursorRequested.model, options)], calls }),
    handle,
    cursorRequested,
  );
  assert.deepEqual(calls, ["status"]);
  assert.deepEqual(confirmed, { model: cursorRequested.model, configOptions: options });
}

// Every initial fail-closed branch stops before the setter and retains the exact request.
const initialFailures: Array<[string, AcpRuntimeStatus]> = [
  ["ACP_SELECTION_MODEL_MISMATCH", {
    details: { configOptions: [select("effort", "high", ["high", "xhigh"], "thought_level")] },
  }],
  ["ACP_SELECTION_MODEL_MISMATCH", status("different-model")],
  ["ACP_SELECTION_CONFIG_OPTIONS_MISSING", { models: { currentModelId: requested.model, availableModelIds: [] } }],
  [ACP_CONFIG_OPTIONS_INVALID, status(requested.model, {})],
  ["ACP_SELECTION_SELECTOR_MISSING", status(requested.model, [select("effort", "high", ["high", "xhigh"])])],
  ["ACP_SELECTION_SELECTOR_AMBIGUOUS", status(requested.model, [
    select("effort", "high", ["high", "xhigh"], "thought_level"),
    select("other", "high", ["high", "xhigh"], "thought_level"),
  ])],
  ["ACP_SELECTION_EFFORT_UNAVAILABLE", status(requested.model, [
    select("effort", "high", ["low", "high"], "thought_level"),
  ])],
];
for (const [code, firstStatus] of initialFailures) {
  const calls: string[] = [];
  await rejectsSelection(
    applyAndConfirmAcpSelection(runtimeFor({ statuses: [firstStatus], calls }), handle, requested),
    code,
  );
  assert.deepEqual(calls, ["status"], `${code} does not set or refresh`);
}

await rejectsSelection(
  applyAndConfirmAcpSelection({} as AcpRuntime, handle, requested),
  "ACP_SELECTION_STATUS_UNAVAILABLE",
);
await rejectsSelection(
  applyAndConfirmAcpSelection(
    { getStatus: async () => { throw new Error("initial status unavailable"); } } as unknown as AcpRuntime,
    handle,
    requested,
  ),
  "ACP_SELECTION_CONFIRMATION_FAILED",
);
await rejectsSelection(
  applyAndConfirmAcpSelection(
    { getStatus: async () => status() } as unknown as AcpRuntime,
    handle,
    requested,
  ),
  "ACP_SELECTION_SET_UNAVAILABLE",
);

// Setter acknowledgement alone never succeeds; every changed/missing/mismatched readback fails
// after one refresh, with no retry that could hide unstable session state.
const confirmedFailures: Array<[string, AcpRuntimeStatus | Error]> = [
  ["ACP_SELECTION_CONFIRMATION_FAILED", new Error("readback unavailable")],
  ["ACP_SELECTION_MODEL_MISMATCH", status("changed-model")],
  ["ACP_SELECTION_CONFIG_OPTIONS_MISSING", { models: { currentModelId: requested.model, availableModelIds: [] } }],
  [ACP_CONFIG_OPTIONS_INVALID, status(requested.model, {})],
  ["ACP_SELECTION_SELECTOR_MISSING", status(requested.model, [select("mode", "agent", ["agent"])])],
  ["ACP_SELECTION_SELECTOR_AMBIGUOUS", status(requested.model, [
    select("effort", "xhigh", ["xhigh"], "thought_level"),
    select("other", "xhigh", ["xhigh"], "thought_level"),
  ])],
  ["ACP_SELECTION_SELECTOR_CHANGED", status(requested.model, [
    select("thought_level", "xhigh", ["xhigh"], "thought_level"),
  ])],
  ["ACP_SELECTION_EFFORT_UNAVAILABLE", status(requested.model, [
    select("effort", "xhigh", ["high"], "thought_level"),
  ])],
  ["ACP_SELECTION_EFFORT_MISMATCH", status(requested.model, [
    select("effort", "high", ["high", "xhigh"], "thought_level"),
  ])],
];
for (const [code, confirmedStatus] of confirmedFailures) {
  const calls: string[] = [];
  let index = 0;
  const runtime = runtimeFor({ statuses: [status()], calls });
  runtime.getStatus = async () => {
    calls.push("status");
    index += 1;
    if (index === 1) return status();
    if (confirmedStatus instanceof Error) throw confirmedStatus;
    return confirmedStatus;
  };
  await rejectsSelection(applyAndConfirmAcpSelection(runtime, handle, requested), code);
  assert.deepEqual(calls, ["status", "set:effort:xhigh", "status"], `${code} performs one refresh only`);
}

// A setter failure is identity-bearing and never attempts a readback.
{
  const calls: string[] = [];
  await rejectsSelection(
    applyAndConfirmAcpSelection(runtimeFor({
      statuses: [status()],
      calls,
      set: () => { throw new Error("setter rejected"); },
    }), handle, requested),
    "ACP_SELECTION_CONFIRMATION_FAILED",
  );
  assert.deepEqual(calls, ["status", "set:effort:xhigh"]);
}

process.stdout.write("ok — ACP selection applies exact advertised state and confirms once before launch\n");
