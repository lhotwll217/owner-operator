// Integration: the post-processor is a fail-closed gate. Incomplete pairs, provider errors,
// and stale artifact provenance must fail; a complete attested pair passes.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const runId = `harness-test-${process.pid}`;
const runDir = join(repoRoot, "eval", "results", "logs", runId);
mkdirSync(runDir, { recursive: true });

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const trace = relative(repoRoot, join(runDir, "case.trace.ndjson"));
const sessionTrace = relative(repoRoot, join(runDir, "case.session.jsonl"));
writeFileSync(join(repoRoot, trace), '{"event":"turn"}\n');
writeFileSync(join(repoRoot, sessionTrace), '{"type":"session"}\n');

const manifestBody = (artifactHash = sha256(readFileSync(join(repoRoot, "package.json")))) => ({
  runId,
  createdAt: new Date().toISOString(),
  modelLabel: "test/model",
  piVersion: "test",
  promptfooVersion: "test",
  gitHead: "test",
  gitStatus: "",
  gitDiffHash: "test",
  artifacts: { "package.json": artifactHash },
});

const writeManifest = (body: ReturnType<typeof manifestBody>) => {
  const manifestHash = sha256(JSON.stringify(body));
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ ...body, manifestHash }));
  return manifestHash;
};

const record = (arm: "owner-operator" | "baseline", manifestHash: string) => ({
  provider: { label: arm },
  vars: { id: "paired-case" },
  testIdx: 0,
  testCase: { metadata: { qtype: "evidence" } },
  response: {
    metadata: {
      runId,
      manifestHash,
      modelLabel: "test/model",
      traceFile: trace,
      sessionTraceFile: sessionTrace,
      toolCallCount: arm === "owner-operator" ? 2 : 3,
      tokensTotal: arm === "owner-operator" ? 100 : 120,
    },
  },
  gradingResult: {
    componentResults: [
      { pass: true, assertion: { type: "llm-rubric" } },
      { pass: true, assertion: { metric: "tool_selection" } },
    ],
  },
});

const run = (results: unknown[]) => {
  const file = join(runDir, "results.json");
  writeFileSync(file, JSON.stringify({ results: { results } }));
  return spawnSync(process.execPath, ["eval/compare.mjs", file, "--gate"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
};

try {
  let manifestHash = writeManifest(manifestBody());
  const complete = [record("owner-operator", manifestHash), record("baseline", manifestHash)];
  const pass = run(complete);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /GATE: PASS/);

  const incomplete = run(complete.slice(0, 1));
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stdout, /incomplete arm pair/);

  const errored: any[] = structuredClone(complete);
  errored[0].response.error = "subject crashed";
  const errorResult = run(errored);
  assert.equal(errorResult.status, 2);
  assert.match(errorResult.stdout, /provider error/);

  manifestHash = writeManifest(manifestBody("0".repeat(64)));
  const stale = run([record("owner-operator", manifestHash), record("baseline", manifestHash)]);
  assert.equal(stale.status, 2);
  assert.match(stale.stdout, /manifest artifact changed since run/);

  writeFileSync(join(runDir, "manifest.json"), "{not valid json\n");
  const corrupt = run([record("owner-operator", manifestHash), record("baseline", manifestHash)]);
  assert.equal(corrupt.status, 2, "a corrupt manifest is a structured gate failure");
  assert.match(corrupt.stdout, /run manifest is invalid JSON/);
  assert.doesNotMatch(corrupt.stderr, /SyntaxError/, "the comparator does not crash with a raw parser stack");

  process.stdout.write("ok — eval compare: complete pairs pass; incomplete/error/stale runs fail closed\n");
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
