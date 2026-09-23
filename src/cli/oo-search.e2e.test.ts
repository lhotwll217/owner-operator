// e2e: `oo search` runs the session-search wrapper inside the daemon. Its output matches the
// wrapper run directly with the same inputs, caller exclusion follows --from-session, env, and
// the product agent's current session, and the daemon's blacklist still applies.
import assert from "node:assert";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";

if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("skip — ripgrep (rg) not installed; session search needs it\n");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "oo-search-e2e-"));
const home = join(root, "home");
const ooHome = join(root, "oo-home");
const privateDir = join(home, "private");
const publicDir = join(home, "public");
for (const dir of [home, privateDir, publicDir, join(ooHome, "sessions")]) mkdirSync(dir, { recursive: true });
// The daemon (and so the wrapper it runs) sees only this disposable home.
process.env.HOME = home;
process.env.OO_HOME = ooHome;
for (const key of ["OO_FROM_SESSION", "CODEX_THREAD_ID", "OO_CALLER_SESSION_ID", "OO_CURRENT_SESSION_ID"]) delete process.env[key];
writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateDir], repos: [] }));

const NEEDLE = "ZZOOSEARCHE2EZZ";
const ids = {
  current: "01a06c11-58bd-7938-a429-ef77a510bd01",
  caller: "01a06c11-58bd-7938-a429-ef77a510bd02",
  other: "01a06c11-58bd-7938-a429-ef77a510bd03",
  blacklisted: "01a06c11-58bd-7938-a429-ef77a510bd04",
};
let minute = 50;
for (const [name, id] of Object.entries(ids)) {
  const timestamp = `2026-09-04T10:${minute++}:51.293Z`;
  writeFileSync(join(ooHome, "sessions", `${timestamp.replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, timestamp, cwd: name === "blacklisted" ? privateDir : publicDir },
    { type: "message", id: "m1", parentId: null, timestamp, message: { role: "assistant", content: [{ type: "text", text: `${NEEDLE} ${name}` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;
const runOo = async (args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(join(repoRoot, "oo"), args, { cwd: publicDir, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
const wrapper = (args: readonly string[], env: NodeJS.ProcessEnv = {}): string => execFileSync(
  process.execPath,
  [join(repoRoot, "src", "session-search", "session-search.mjs"), ...args],
  { cwd: publicDir, env: { ...process.env, ...env }, encoding: "utf8" },
);
const matchedIds = (stdout: string): string[] =>
  (JSON.parse(stdout) as { matches: Array<{ id: string }> }).matches.map((match) => match.id).sort();

try {
  const { startDaemon } = await import("../daemon/runtime");
  daemon = await startDaemon({
    port: 0,
    dbPath: join(ooHome, "state.db"),
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
  });

  // Same output as the wrapper for the same inputs, text and --json.
  const query = ["--query", NEEDLE, "--owner-operator"];
  const text = await runOo(["search", ...query]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, wrapper(query), "text output is the wrapper's output");
  const json = await runOo(["search", ...query, "--json"]);
  assert.equal(json.stdout, wrapper([...query, "--json"]), "--json output is the wrapper's output");
  assert.match(text.stdout, /discovery_session_exclusions=unavailable/, "no caller identity → exclusion reported unavailable");

  // Blacklist enforced in the daemon: the private session never appears.
  assert.deepEqual(matchedIds(json.stdout), [ids.caller, ids.current, ids.other].sort(), "blacklisted cwd is dropped");

  // Caller exclusion: --from-session, then env, plus the product agent's current session.
  const flagged = await runOo(["search", ...query, "--from-session", ids.caller]);
  assert.match(flagged.stdout, new RegExp(`discovery_session_exclusions=applied:${ids.caller}\\b`), "--from-session is excluded");
  const fromEnv = await runOo(["search", ...query, "--json"], { OO_FROM_SESSION: ids.caller });
  assert.deepEqual(matchedIds(fromEnv.stdout), [ids.current, ids.other].sort(), "OO_FROM_SESSION caller is excluded");
  const product = await runOo(["search", ...query], { OO_CALLER_SESSION_ID: ids.caller, OO_CURRENT_SESSION_ID: ids.current });
  assert.match(product.stdout, new RegExp(`discovery_session_exclusions=applied:${ids.current},${ids.caller}\\b`),
    "the product agent's current session and its caller are both excluded");
  assert.equal(product.stdout, wrapper(query, { OO_CALLER_SESSION_ID: ids.caller, OO_CURRENT_SESSION_ID: ids.current }),
    "the daemon passes the caller ids exactly as the wrapper's env inputs");

  // A wrapper flag's value is never read as oo's own flag, even when it looks like one.
  const literal = await runOo(["search", "--query", "--from-session", "--owner-operator", "--json"]);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal((JSON.parse(literal.stdout) as { query: string }).query, "--from-session", "the value stays the query");
  assert.match(literal.stdout, /"applied":false/, "and is not taken as provenance");
  const both = await runOo(["search", "--query", "--from-session", "--from-session", ids.caller, "--owner-operator", "--json"]);
  assert.deepEqual((JSON.parse(both.stdout) as { discoverySessionExclusions: unknown }).discoverySessionExclusions,
    { applied: true, sessionIds: [ids.caller] }, "a real --from-session after it still applies");

  // --max-chars is a hard ceiling on the final output, after the wrapper's own fields, in every
  // mode, and the daemon path stays byte-identical to the wrapper.
  const BUDGET = "ZZBUDGETZZ";
  for (let index = 0; index < 40; index++) {
    const id = `01a06c11-58bd-7938-a429-ef77a510${String(index).padStart(4, "0")}`;
    const timestamp = `2026-09-05T10:${String(index).padStart(2, "0")}:51.293Z`;
    writeFileSync(join(ooHome, "sessions", `${timestamp.replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`), [
      { type: "session", version: 3, id, timestamp, cwd: publicDir },
      { type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: `${BUDGET} ${"context ".repeat(80)}` }] } },
      { type: "message", id: "m2", parentId: "m1", timestamp, message: { role: "assistant", content: [{ type: "text", text: `${BUDGET} ${"answer ".repeat(80)}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  for (const maxChars of [600, 700, 1_000, 4_000]) {
    for (const mode of [[], ["--json"], ["--candidates"], ["--candidates", "--json"]]) {
      const args = ["--query", BUDGET, "--owner-operator", "--max-chars", String(maxChars), ...mode];
      const bounded = await runOo(["search", ...args]);
      assert.equal(bounded.status, 0, bounded.stderr);
      assert.ok(Buffer.byteLength(bounded.stdout) <= maxChars,
        `${mode.join(" ") || "text"} at --max-chars ${maxChars} printed ${Buffer.byteLength(bounded.stdout)} bytes`);
      assert.equal(bounded.stdout, wrapper(args), "the daemon path matches the wrapper byte for byte");
    }
  }
  const saturated = JSON.parse((await runOo(["search", "--query", BUDGET, "--owner-operator", "--max-chars", "4000", "--json"])).stdout) as {
    shown: number; omittedByBudget?: number; matches: Array<{ namespace: string }>;
  };
  assert.ok(saturated.shown > 0 && (saturated.omittedByBudget ?? 0) > 0, "a saturated result keeps hits and reports omissions");
  assert.ok(saturated.matches.every((match) => match.namespace === "owner-operator"), "wrapper fields survive fitting");

  // Wrapper errors and exit codes pass through.
  const bad = await runOo(["search", "--nope"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, "unsupported session-search argument: --nope\n");
  const help = await runOo(["search", "--help"]);
  assert.match(help.stdout, /^Usage: oo search/, "the wrapper's help is the contract");
} finally {
  (await import("../gateway/client")).resolveBackend().then((gateway) => gateway.close(), () => undefined);
  await daemon?.close();
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — oo search runs the wrapper in the daemon: same output, caller exclusion, blacklist\n");
