import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionStateWidgetProof } from "./session-state-widget-proof";
import { closeSandboxUser, loadSandboxPiServices, materializeSandboxUser } from "../eval/sandbox-user";
import { evalSandboxPath } from "../eval/sandbox.mjs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "oo-widget-cleanup-"));
const proofRoot = evalSandboxPath(`widget-cleanup-${process.pid}-${Date.now()}`);
try {
  const credentials = join(root, "fake-credentials");
  mkdirSync(credentials);
  const fakeSecret = "FAKE-CREDENTIAL-CLEANUP-SENTINEL";
  writeFileSync(join(credentials, "auth.json"), JSON.stringify({ fake: { type: "api_key", key: fakeSecret } }));
  const before = { ...process.env };
  await assert.rejects(runSessionStateWidgetProof({ root: proofRoot, live: { credentialSource: credentials } }), /credential is missing/);
  assert.deepEqual(readdirSync(proofRoot), ["diagnostics"], "partial setup keeps only sanitized diagnostics");
  const setupDiagnostic = readFileSync(join(proofRoot, "diagnostics", "diagnostic.json"), "utf8");
  assert.ok(!setupDiagnostic.includes(fakeSecret));
  assert.ok(!setupDiagnostic.includes(credentials));
  assert.deepEqual({ ...process.env }, before);
  rmSync(proofRoot, { recursive: true, force: true });

  writeFileSync(join(credentials, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: fakeSecret } }));
  await assert.rejects(runSessionStateWidgetProof({ root: proofRoot, live: { credentialSource: credentials,
      loadEnrichment: async () => (await import(new URL("./absent-widget-proof.ts", import.meta.url).href)).enrichThread,
    } }), /Cannot find module/);
  assert.deepEqual({ ...process.env }, before, "import failure restores the caller environment");
  assert.equal(existsSync(proofRoot), false, "verified import-failure cleanup removes the disposable home");

  writeFileSync(join(credentials, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: fakeSecret } }));
  const sandbox = materializeSandboxUser({ profile: "deterministic-harness", root: proofRoot, sourcePiAgentDir: credentials });
  const services = await loadSandboxPiServices(sandbox);
  assert.ok(sandbox.credentialFilesUnavailable(), "memory loading removes every copied config file");
  const model = services.modelRuntime.getModel("openai", "gpt-4.1");
  assert.ok(model);
  assert.ok(await services.modelRuntime.getAuth(model), "fake credential remains usable in memory without inference");
  writeFileSync(sandbox.paths.piAuth, JSON.stringify({ key: fakeSecret }));
  const failed = await closeSandboxUser(sandbox, undefined, async () => {
    assert.ok(sandbox.credentialFilesUnavailable(), "secrets are removed before teardown starts");
    throw new Error(`forced teardown failure AUTH_TOKEN=${fakeSecret}`);
  }, { authToken: fakeSecret, path: credentials });
  assert.equal(failed.teardownVerified, false);
  assert.deepEqual(readdirSync(proofRoot), ["diagnostics"]);
  const diagnostic = readFileSync(join(failed.preservedDiagnostics!, "diagnostic.json"), "utf8");
  assert.ok(!diagnostic.includes(fakeSecret));
  assert.ok(!diagnostic.includes(credentials));
  assert.match(diagnostic, /forced teardown failure/);
  rmSync(proofRoot, { recursive: true, force: true });

  const failedLoad = materializeSandboxUser({ profile: "deterministic-harness", root: proofRoot, sourcePiAgentDir: credentials });
  const createRuntime = ModelRuntime.create;
  try {
    ModelRuntime.create = async () => { throw new Error("forced runtime initialization failure"); };
    await assert.rejects(loadSandboxPiServices(failedLoad), /forced runtime initialization failure/);
    assert.ok(failedLoad.credentialFilesUnavailable(), "failed runtime loading removes copied credentials and settings");
  } finally {
    ModelRuntime.create = createRuntime;
    await closeSandboxUser(failedLoad, undefined, async () => {});
  }
  console.log("ok - widget proof: setup/import failures, in-memory credentials, secret-first close, sanitized failed-teardown diagnostics");
} finally {
  rmSync(proofRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
