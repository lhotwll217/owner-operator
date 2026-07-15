// Integration: Owner Operator session configuration over isolated harness files.
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleKind, ScheduledPayloadKind } from "@owner-operator/core";
import {
  evalSettingsOverrides,
  lastAssistantError,
  ownerOperatorPrompt,
  ownerOperatorPiServices,
  ownerOperatorTools,
  ownerOperatorCustomTools,
  repoRoot,
  runScheduledPrompt,
} from "./agent";

const configRoot = mkdtempSync(join(tmpdir(), "oo-agent-config-"));
try {
  const ooHome = join(configRoot, "oo-home");
  const task = join(configRoot, "task");
  mkdirSync(join(ooHome, "pi"), { recursive: true });
  mkdirSync(join(task, ".pi"), { recursive: true });
  writeFileSync(join(ooHome, "pi", "auth.json"), JSON.stringify({ owned: { type: "api_key", key: "secret" } }));
  writeFileSync(join(ooHome, "pi", "settings.json"), JSON.stringify({ defaultProvider: "owned", defaultModel: "owned-model" }));
  writeFileSync(join(task, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "ambient", defaultModel: "ambient-model" }));
  const services = ownerOperatorPiServices(ooHome);
  assert.deepEqual(services.authStorage.list(), ["owned"], "embedded runtime reads only owned credentials");
  assert.equal(services.settingsManager.getDefaultProvider(), "owned");
  assert.equal(services.settingsManager.getDefaultModel(), "owned-model");
  assert.equal(services.settingsManager.isProjectTrusted(), false, "project Pi settings cannot alter harness policy");
} finally {
  rmSync(configRoot, { recursive: true, force: true });
}

assert.deepEqual(evalSettingsOverrides({}), {}, "product sessions keep their configured transport");

const priorOoHome = process.env.OO_HOME;
const setupGateHome = join(configRoot, "setup-gate-home");
process.env.OO_HOME = setupGateHome;
const setupGateResult = await runScheduledPrompt({
  cwd: configRoot,
  runId: "run-before-setup",
  schedule: {
    id: "schedule-before-setup",
    name: "before setup",
    enabled: true,
    trigger: { kind: ScheduleKind.At, at: new Date().toISOString() },
    payload: { kind: ScheduledPayloadKind.Prompt, prompt: "must not run", toolsAllow: [] },
    cwd: configRoot,
    timeoutSeconds: 30,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRunAt: null,
  },
  payload: { kind: ScheduledPayloadKind.Prompt, prompt: "must not run", toolsAllow: [] },
  signal: new AbortController().signal,
});
assert.equal(setupGateResult.exitCode, 1);
assert.match(setupGateResult.stderr, /setup required/i, "scheduled model work fails closed before consent");
if (priorOoHome === undefined) delete process.env.OO_HOME;
else process.env.OO_HOME = priorOoHome;
assert.deepEqual(
  evalSettingsOverrides({ OO_EVAL_READ_ONLY: "1", OO_EVAL_TRANSPORT: "sse" }),
  { transport: "sse" },
  "read-only eval subjects use the manifest-recorded stable transport",
);
assert.deepEqual(
  evalSettingsOverrides({
    OO_EVAL_READ_ONLY: "1",
    OO_EVAL_DEFAULT_PROVIDER: "example-provider",
    OO_EVAL_DEFAULT_MODEL: "example-model",
  }),
  { defaultProvider: "example-provider", defaultModel: "example-model" },
  "the manifest-selected eval model overrides ambient Pi defaults",
);
assert.throws(
  () => evalSettingsOverrides({ OO_EVAL_TRANSPORT: "sse" }),
  /read-only eval/i,
  "the eval transport override cannot leak into product sessions",
);
assert.throws(
  () => evalSettingsOverrides({ OO_EVAL_READ_ONLY: "1", OO_EVAL_DEFAULT_MODEL: "orphan-model" }),
  /must be set together/i,
  "partial eval model pins fail closed",
);
assert.throws(
  () => evalSettingsOverrides({ OO_EVAL_READ_ONLY: "1", OO_EVAL_TRANSPORT: "auto" }),
  /unsupported eval transport/i,
);

// Posture keeps every standard file/shell tool present; the permission mode decides each operation.
for (const t of ["bash", "read", "grep", "find", "ls", "edit", "write", "get_current_session_state", "mark_thread_done", "query_database", "schedule_prompt", "manage_schedule"]) {
  assert.ok(ownerOperatorTools.some((tool) => tool === t), `owner tools must include ${t}`);
}

// Every allowlisted custom tool ships (so the allowlist can't reference a missing tool).
// The raw file tools are same-name extension overrides, covered by privacy-tools.test.
for (const t of ["get_current_session_state", "mark_thread_done", "query_database", "schedule_prompt", "manage_schedule"]) {
  assert.ok(ownerOperatorCustomTools.some((tool) => tool.name === t), `owner custom tools must include ${t}`);
}

assert.ok(!ownerOperatorCustomTools.some((tool) => tool.name === "search_sessions"), "session search is a skill, not a duplicate custom tool");

const harnessPrompt = ownerOperatorPrompt();
const sessionSearchSkill = readFileSync(
  join(repoRoot, "src", "agent", "skills", "session-search", "SKILL.md"),
  "utf8",
);
for (const mode of ["Direct", "Indexed", "Progressive", "Exhaustive"]) {
  assert.match(harnessPrompt, new RegExp(`\\*\\*${mode}\\*\\*`), `the harness classifies ${mode.toLowerCase()} discovery`);
}
for (const flag of ["--query", "--candidates", "--skim", "--session"]) {
  assert.doesNotMatch(harnessPrompt, new RegExp(flag), `the harness delegates ${flag} mechanics to the skill`);
  assert.match(sessionSearchSkill, new RegExp(flag), `the session-search skill owns ${flag} mechanics`);
}
assert.doesNotMatch(
  sessionSearchSkill,
  /get_current_session_state|query_database/,
  "the reusable transcript skill does not route between Owner Operator's other tools",
);

const queryTool = ownerOperatorCustomTools.find((tool) => tool.name === "query_database");
assert.doesNotMatch(
  queryTool?.description ?? "",
  /CREATE statement/,
  "query_database describes the documented columns it returns, not raw SQLite DDL",
);

const session = (messages: unknown[]) => ({ state: { messages } }) as any;
assert.equal(lastAssistantError(session([{ role: "assistant", stopReason: "stop", content: [] }])), null);
assert.equal(
  lastAssistantError(session([{ role: "assistant", stopReason: "error", errorMessage: "usage exhausted", content: [] }])),
  "usage exhausted",
);
assert.equal(
  lastAssistantError(session([{ role: "assistant", stopReason: "error", content: [] }])),
  "model turn stopped with an error",
);

process.stdout.write("ok — session capabilities: constrained skill execution plus typed state tools\n");
