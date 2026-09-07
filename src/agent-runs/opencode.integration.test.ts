// Native-command contract: exact stable/V2 routing survives real ACPX initialization,
// selection and disposal. Fake ACP subprocesses prove OO integration, not release compatibility.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunHarness } from "@owner-operator/core";
import { openCodeBinaryPath } from "./acp-launcher";
import { createGetHarnessDetailsTool } from "../agent/tools/get-harness-details";
import { startDaemon } from "../daemon/runtime";
import { connectGateway } from "../gateway/client";

const root = mkdtempSync(join(tmpdir(), "oo-opencode-"));
const previousEnv = { ...process.env };
// Shell metacharacters must remain literal in wrapped executable paths.
const bin = join(root, "bin '$literal`path`");
const model = "provider/exact/model[1m]";
mkdirSync(bin);
process.env.HOME = root;
process.env.OO_HOME = root;
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.OPENCODE_BIN_PATH = "/wrong/backend";
const fixture = `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const identity = __IDENTITY__;
if (process.env.OPENCODE_BIN_PATH) process.exit(91);
if (process.argv[2] === '--version') { console.log(identity === 'opencode2' ? 'opencode2 v0.0.0-fixture' : '1.18.29'); process.exit(0); }
if (process.argv[2] !== 'acp') process.exit(92);
let effort = 'high';
let pending;
const options = () => [
 { id:'model', name:'Model', category:'model', type:'select', currentValue:${JSON.stringify(model)},
   options:[{value:${JSON.stringify(model)},name:'Fixture'}] },
 { id:'effort', name:'Effort', category:'thought_level', type:'select', currentValue:effort,
   options:[{value:'high',name:'High'},{value:'low',name:'Low'}] }
];
for await (const line of createInterface({input:process.stdin})) {
 const m = JSON.parse(line);
 appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))}, JSON.stringify({identity,method:m.method,params:m.params})+'\\n');
 let result = {};
 if (m.method === 'initialize') result = {protocolVersion:1,agentCapabilities:existsSync(${JSON.stringify(join(root, "capabilities.json"))}) ? JSON.parse(readFileSync(${JSON.stringify(join(root, "capabilities.json"))},'utf8')) : {loadSession:true},agentInfo:{name:identity,version:'fixture'},authMethods:[]};
 if (m.method === 'session/new') result = {sessionId:identity+'-child',configOptions:options()};
 if (m.method === 'session/load' || m.method === 'session/resume') result = {configOptions:options()};
 if (m.method === 'session/set_config_option') { effort=m.params.value; result={configOptions:options()}; }
 if (m.method === 'session/prompt') {
   console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:identity+' fixture answer'}}}}));
   pending = m.id;
   if (!m.params.prompt[0].text.startsWith('hold')) {
     console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}}));
     pending = undefined;
   }
   continue;
 }
 if (m.method === 'session/cancel' && pending !== undefined) {
   console.log(JSON.stringify({jsonrpc:'2.0',id:pending,result:{stopReason:'cancelled'}}));
   pending = undefined;
 }
 if (m.id !== undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}
`;
try {
  for (const harness of [AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2] as const) {
    writeFileSync(join(bin, harness), fixture.replace("__IDENTITY__", JSON.stringify(harness)), { mode: 0o755 });
  }
  const tool = createGetHarnessDetailsTool();
  const context = {} as Parameters<typeof tool.execute>[4];
  for (const harness of [AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2] as const) {
    assert.equal(openCodeBinaryPath(harness), join(bin, harness));
    for (const effort of ["low", null, "ultra"] as const) {
      const result = await tool.execute("inspect", { inspect: [{ harness, model, effort }] }, undefined, undefined, context);
      const row = result.details.capabilities.harnesses[0]!;
      assert.equal(row.harness, harness);
      assert.equal(row.acpxAgent, harness);
      assert.equal(row.runtime?.backend.name, harness);
      assert.equal(row.runtime?.backend.version, harness === "opencode2" ? "opencode2 v0.0.0-fixture" : "1.18.29");
      assert.equal(row.runtime?.backend.executablePath, join(bin, harness));
      assert.equal(row.session?.agentCapabilities?.loadSession, true);
      if (effort === "ultra") {
        assert.match(row.error!, /ACP_SELECTION_EFFORT_UNAVAILABLE/);
        assert.equal(row.confirmation, null, "unsupported effort cannot become a successful selection");
      } else {
        assert.equal(row.error, null);
        assert.deepEqual(row.confirmation, { model, ...(effort === null ? {} : { effort }) });
      }
      assert.equal(result.details.account[0]!.harness, harness);
      assert.equal(result.details.account[0]!.source, null, "provider catalog is never account evidence");
    }
    const invalid = await tool.execute("invalid", {
      inspect: [{ harness, model: "provider/not-advertised", effort: null }],
    }, undefined, undefined, context);
    assert.ok(invalid.details.capabilities.harnesses[0]!.error, "unadvertised model is refused before any turn");
    assert.equal(invalid.details.capabilities.harnesses[0]!.confirmation, null);
  }
  const requests = readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const harness of ["opencode", "opencode2"]) {
    const own = requests.filter(({ identity }) => identity === harness);
    assert.deepEqual(own.filter(({ method }) => method === "session/set_config_option").map(({ params }) => params),
      [{ sessionId: `${harness}-child`, configId: "effort", value: "low" }],
      "null and unsupported effort never write a setting");
    assert.equal(own.some(({ method }) => method === "session/prompt"), false, "inspection never runs inference");
  }
  // Gateway -> executor -> real ACPX -> native command -> durable completion. This catches
  // acceptance at inspection but rejection or identity substitution at the execution boundary.
  const daemon = await startDaemon({
    port: 0, watch: false, enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
    agentRuns: { tickMs: 20 },
  });
  const gateway = await connectGateway();
  assert.ok(gateway);
  try {
    for (const harness of [AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2]) {
      const launched = await gateway.delegateAgent({ harness, model, effort: "low", cwd: root, task: "answer", timeoutSeconds: 20 });
      const done = await gateway.waitAgentRun(launched.id, 20);
      assert.equal(done.status, "completed", done.error ?? "");
      assert.equal(done.harness, harness);
      assert.deepEqual(done.harnessIdentity, { observed: true, model, effort: "low" });
      assert.equal(done.childSessionId, `${harness}-child`);
      assert.ok(done.activity);
      assert.match(done.resultTail!, new RegExp(`${harness} fixture answer`));
      const resumed = await gateway.resumeAgentRun(done.id, "follow up");
      const resumedDone = await gateway.waitAgentRun(resumed.id, 20);
      assert.equal(resumedDone.status, "completed", resumedDone.error ?? "");
      assert.equal(resumedDone.resumeOfRunId, done.id);
      assert.equal(resumedDone.childSessionId, done.childSessionId);
      assert.equal(resumedDone.cwd, done.cwd);
      assert.deepEqual(await gateway.agentRun(done.id), done, "resume preserves the original terminal row");
      const invalid = await gateway.delegateAgent({ harness, model, effort: "ultra", cwd: root, task: "never sent", timeoutSeconds: 20 });
      const rejected = await gateway.waitAgentRun(invalid.id, 20);
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.harness, harness);
      assert.match(rejected.error!, /ACP_SELECTION_EFFORT_UNAVAILABLE/);
      const held = await gateway.delegateAgent({ harness, model, effort: null, cwd: root, task: "hold", timeoutSeconds: 20 });
      const deadline = Date.now() + 10_000;
      while (!(await gateway.agentRun(held.id))?.activity) {
        assert.ok(Date.now() < deadline, "held run reports activity before cancellation");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const cancelled = await gateway.cancelAgentRun(held.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal((await gateway.waitAgentRun(held.id, 5)).status, "cancelled");
    }
    // An observed absence of both continuation methods must prevent a doomed row and UI control.
    // Conversely, ACP session/resume works without legacy loadSession and must remain available.
    for (const harness of [AgentRunHarness.OpenCode, AgentRunHarness.OpenCode2]) {
      for (const capabilities of [{ loadSession: false }, {}, { loadSession: false, sessionCapabilities: { resume: {} } }]) {
        writeFileSync(join(root, "capabilities.json"), JSON.stringify(capabilities));
        const launched = await gateway.delegateAgent({ harness, model, effort: null, cwd: root, task: "capabilities", timeoutSeconds: 20 });
        const done = await gateway.waitAgentRun(launched.id, 20);
        assert.equal(done.status, "completed", done.error ?? "");
        const supported = "sessionCapabilities" in capabilities;
        assert.equal((await gateway.agentState()).runs.find(({ id }) => id === done.id)?.canResume, supported);
        const before: number = (await gateway.listAgentRuns()).length;
        if (supported) {
          const resumed = await gateway.resumeAgentRun(done.id, "follow up");
          assert.equal((await gateway.waitAgentRun(resumed.id, 20)).status, "completed");
        } else {
          await assert.rejects(gateway.resumeAgentRun(done.id, "never sent"), /did not advertise session\/load or session\/resume/);
          assert.equal((await gateway.listAgentRuns()).length, before, "refused continuation creates no linked row");
          const invalid = await gateway.delegateAgent({ harness, model, effort: "ultra", cwd: root, task: "never sent", timeoutSeconds: 20 });
          const failed = await gateway.waitAgentRun(invalid.id, 20);
          assert.equal(failed.status, "failed");
          assert.equal((await gateway.agentState()).runs.find(({ id }) => id === failed.id)?.canRetry, false);
          await assert.rejects(gateway.retryAgentRun(failed.id), /did not advertise session\/load or session\/resume/);
          assert.equal((await gateway.listAgentRuns()).length, before + 1, "refused retry creates no linked row");
        }
      }
    }
    rmSync(join(root, "capabilities.json"));
    // Both a symlink and a forwarding wrapper can disguise stable behind the V2 filename.
    // Checking the version signature must reject each through inspection AND delegated launch.
    for (const alias of ["symlink", "wrapper"]) {
      rmSync(join(bin, "opencode2"));
      if (alias === "symlink") symlinkSync(join(bin, "opencode"), join(bin, "opencode2"));
      else writeFileSync(join(bin, "opencode2"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const r=spawnSync(${JSON.stringify(join(bin, "opencode"))},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status);`, { mode: 0o755 });
      const inspected = await tool.execute("alias", { harnesses: [AgentRunHarness.OpenCode2] }, undefined, undefined, context);
      assert.equal(inspected.details.capabilities.harnesses[0]!.runtime, null);
      assert.match(inspected.details.capabilities.harnesses[0]!.error!, /opencode2 backend identity could not be confirmed.*1\.18\.29/);
      const launched = await gateway.delegateAgent({ harness: AgentRunHarness.OpenCode2, model, effort: null, cwd: root, task: "never sent", timeoutSeconds: 20 });
      const rejected = await gateway.waitAgentRun(launched.id, 20);
      assert.equal(rejected.status, "failed");
      assert.equal(rejected.childSessionId, null);
      assert.match(rejected.error!, /opencode2 backend identity could not be confirmed/);
    }
    rmSync(join(bin, "opencode2"));
    const missingLaunch = await gateway.delegateAgent({
      harness: AgentRunHarness.OpenCode2, model, effort: null, cwd: root, task: "never sent", timeoutSeconds: 20,
    });
    const missingResult = await gateway.waitAgentRun(missingLaunch.id, 20);
    assert.equal(missingResult.status, "failed");
    assert.equal(missingResult.harness, AgentRunHarness.OpenCode2);
    assert.equal(missingResult.childSessionId, null);
    assert.match(missingResult.error!, /opencode2 CLI not found/);
  } finally {
    gateway.close();
    await daemon.close();
  }
  const missing = await tool.execute("missing", { harnesses: [AgentRunHarness.OpenCode2] }, undefined, undefined, context);
  assert.match(missing.details.capabilities.harnesses[0]!.error!, /opencode2 CLI not found/);
  assert.equal(missing.details.capabilities.harnesses[0]!.session, null, "stable cannot satisfy a missing V2 command");
  assert.deepEqual(readdirSync(join(root, "agent-runs", "process-leases")), [], "all probes released their leases");
  process.stdout.write("ok — OpenCode identities use real ACPX selection, exact native paths and fail closed\n");
} finally {
  process.env = previousEnv;
  rmSync(root, { recursive: true, force: true });
}
