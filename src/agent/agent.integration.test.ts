// Integration: Owner Operator session configuration over isolated harness files.
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_AGENT_TOOL_IDS, ScheduleKind, ScheduledPayloadKind } from "@owner-operator/core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createOwnerOperatorSession,
  evalSettingsOverrides,
  lastAssistantError,
  ownerOperatorPrompt,
  ownerOperatorPiServices,
  ownerOperatorTools,
  ownerOperatorCustomTools,
  repoRoot,
  runScheduledPrompt,
} from "./agent";
import { AGENT_RUN_COMPLETION_MESSAGE_TYPE } from "../agent-runs/agent-run-completion";
import { helpTree } from "../cli/help";
import { NOUNS } from "../cli/operations";
import { verbHelp } from "../cli/operations/operation";

const configRoot = mkdtempSync(join(tmpdir(), "oo-agent-config-"));
const priorOoHome = process.env.OO_HOME;
try {
  const ooHome = join(configRoot, "oo-home");
  const task = join(configRoot, "task");
  mkdirSync(join(ooHome, "pi"), { recursive: true });
  mkdirSync(join(task, ".pi"), { recursive: true });
  writeFileSync(join(ooHome, "pi", "auth.json"), JSON.stringify({ owned: { type: "api_key", key: "secret" } }));
  writeFileSync(join(ooHome, "pi", "settings.json"), JSON.stringify({ defaultProvider: "owned", defaultModel: "owned-model" }));
  writeFileSync(join(task, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "ambient", defaultModel: "ambient-model" }));
  const services = await ownerOperatorPiServices(ooHome);
  assert.deepEqual(
    (await services.modelRuntime.listCredentials()).map((credential) => credential.providerId),
    ["owned"],
    "embedded runtime reads only owned credentials",
  );
  assert.equal(services.settingsManager.getDefaultProvider(), "owned");
  assert.equal(services.settingsManager.getDefaultModel(), "owned-model");
  assert.equal(services.settingsManager.isProjectTrusted(), false, "project Pi settings cannot alter harness policy");
  const injectedCredentials = new InMemoryCredentialStore();
  await injectedCredentials.modify("owned", async () => ({ type: "api_key", key: "memory-only" }));
  const injectedServices = await ownerOperatorPiServices(ooHome, injectedCredentials);
  assert.deepEqual(
    (await injectedServices.modelRuntime.listCredentials()).map((credential) => credential.providerId),
    ["owned"],
    "callers can isolate production composition from a readable credential file",
  );
  process.env.OO_HOME = ooHome;
  const headless = await createOwnerOperatorSession("chat", { ephemeral: true });
  assert.ok(
    headless.session.extensionRunner.getMessageRenderer(AGENT_RUN_COMPLETION_MESSAGE_TYPE),
    "the shared headless session path registers delegated-run completion delivery",
  );
  headless.session.dispose();

  rmSync(join(ooHome, "pi", "auth.json"));
  const memoryBacked = await createOwnerOperatorSession("chat", {
    ephemeral: true,
    toolsAllow: [],
    credentials: injectedCredentials,
  });
  assert.equal(existsSync(join(ooHome, "pi", "auth.json")), false,
    "in-memory production credentials do not recreate an agent-readable auth file");
  memoryBacked.session.dispose();

} finally {
  if (priorOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorOoHome;
  rmSync(configRoot, { recursive: true, force: true });
}

assert.deepEqual(evalSettingsOverrides({}), {}, "product sessions keep their configured transport");

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
for (const t of ["bash", "read", "grep", "find", "ls", "edit", "write"]) {
  assert.ok(ownerOperatorTools.some((tool) => tool === t), `owner tools must include ${t}`);
}

// Every capability reaches the Operator as an `oo` verb (adr/0001-agent-uses-its-own-cli.md).
assert.deepEqual(ownerOperatorCustomTools, [], "the Operator has no native custom tools");
for (const t of RETIRED_AGENT_TOOL_IDS) {
  assert.ok(!ownerOperatorTools.includes(t as never), `${t} is retired from the roster`);
}

const harnessPrompt = ownerOperatorPrompt();
assert.ok(harnessPrompt.includes(`\`\`\`text\n${helpTree().trimEnd()}\n\`\`\``), "the prompt embeds every generated `oo` help page verbatim");
assert.ok(!harnessPrompt.includes("<!-- generated:"), "the generation marker never reaches the model");
// The prose the prompt adds around the embedded help.
const authoredPrompt = harnessPrompt.replace(helpTree().trimEnd(), "");
assert.match(harnessPrompt, /select-harness-for-delegation/);
assert.match(harnessPrompt, /unless the owner explicitly supplied harness, model, and\s+effort/i);
assert.match(harnessPrompt, /explicit owner choices win/i);
for (const mechanic of [
  "user-harness-preferences.md",
  "oo harness details",
  "oo harness propose",
  "oo harness approve",
  "Task roles",
  "allowance",
]) {
  assert.ok(
    !authoredPrompt.toLowerCase().includes(mechanic.toLowerCase()),
    `the prompt's prose delegates ${mechanic} mechanics to the bundled skill and \`oo harness\` help`,
  );
}
assert.match(harnessPrompt, /completion arrives automatically/i);
assert.match(harnessPrompt, /run management is for\s+owner-directed lifecycle control/i);
const sessionSearchSkill = readFileSync(
  join(repoRoot, "src", "agent", "skills", "session-search", "SKILL.md"),
  "utf8",
);
const delegationSelectionSkill = readFileSync(
  join(repoRoot, "src", "agent", "skills", "select-harness-for-delegation", "SKILL.md"),
  "utf8",
);
for (const operation of ["oo harness details", "oo harness propose", "oo harness approve", "oo runs delegate"]) {
  assert.match(delegationSelectionSkill, new RegExp(`\\b${operation}\\b`),
    `the selection workflow invokes ${operation}`);
}
assert.doesNotMatch(delegationSelectionSkill, /\$OO_HOME\/workspace\/.*\.md/,
  "the selection workflow consumes snapshot-owned preferences instead of reading a file directly");
for (const mode of ["Direct", "Indexed", "Progressive", "Exhaustive"]) {
  assert.match(harnessPrompt, new RegExp(`\\*\\*${mode}\\*\\*`), `the harness classifies ${mode.toLowerCase()} discovery`);
}
// The embedded help names oo's own resume flag `--session`, not session-search mechanics.
for (const flag of ["--query", "--candidates", "--skim", "--session"]) {
  assert.doesNotMatch(authoredPrompt, new RegExp(flag), `the harness delegates ${flag} mechanics to the skill`);
  assert.match(sessionSearchSkill, new RegExp(flag), `the session-search skill owns ${flag} mechanics`);
}
assert.doesNotMatch(
  sessionSearchSkill,
  /oo session-state|oo db\b/,
  "the reusable transcript skill does not route between Owner Operator's other surfaces",
);
assert.match(authoredPrompt, /`oo session-state list --state needs-you`/, "what-needs-me reads the authoritative state filter");
assert.match(verbHelp("session-state", "done", NOUNS["session-state"].verbs.done!), /MUST run `oo session-state done <id>`/,
  "the done verb's own help carries the mark-done rule");
assert.match(verbHelp("runs", "resume", NOUNS.runs.verbs.resume!), /submitted a prompt or is already a resume successor/,
  "the resume verb's own help carries its eligibility");
for (const moved of [/MUST run `oo session-state done/, /completion arrives automatically/i, /schedule_runs/, /thread_details\.topic/]) {
  assert.doesNotMatch(authoredPrompt, moved, `${moved} lives in the help the prompt embeds, not in prompt prose`);
}

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
