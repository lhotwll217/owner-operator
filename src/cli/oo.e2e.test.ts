// e2e: regular `oo` owns the headless/resume contract. Failure paths exit before any
// model session is built, so this stays hermetic and fast.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { markOnboarded } from "@owner-operator/core";

const ooBin = join(repoRoot, "oo");
const ooHome = mkdtempSync(join(tmpdir(), "oo-cli-e2e-"));
process.env.OO_HOME = ooHome; // in-process store seam (the --done seed) targets the same hermetic home
const opts = { cwd: repoRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, OO_HOME: ooHome } } as const;
let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;

const runOo = async (args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(ooBin, args, { cwd: repoRoot, env: { ...process.env, OO_HOME: ooHome } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

try {
  const help = spawnSync(ooBin, ["--help"], opts);
  assert.equal(help.status, 0, `oo --help exits 0 (got ${help.status}; stderr: ${help.stderr})`);
  assert.match(help.stdout, /oo -p \| --prompt/, "top-level help advertises -p");
  assert.match(help.stdout, /oo --continue/, "top-level help advertises --continue");
  for (const noun of ["session-state", "runs", "schedules", "db", "harness", "search", "skill"]) {
    assert.match(help.stdout, new RegExp(`oo ${noun}\\n`), `top-level help lists the ${noun} noun`);
  }
  assert.equal(help.stderr, "", "top-level help is clean: no agent/runtime warnings");
  assert.equal(existsSync(join(ooHome, "workspace", "AGENTS.md")), true, "every CLI exit seeds the workspace");

  for (const argv of [["daemon", "--help"], ["doctor", "-h"]]) {
    const help = spawnSync(ooBin, argv, opts);
    assert.equal(help.status, 0, `${argv.join(" ")} exits 0`);
    assert.match(help.stdout, /Owner Operator \(oo\)/, `${argv.join(" ")} prints usage`);
  }
  assert.equal(existsSync(join(ooHome, "daemon.json")), false, "`oo daemon --help` starts no daemon");

  const nounHelp = spawnSync(ooBin, ["session-state", "--help"], opts);
  assert.equal(nounHelp.status, 0, `noun help exits 0 (stderr: ${nounHelp.stderr})`);
  assert.match(nounHelp.stdout, /^\s+list\s/m, "noun help lists list");
  assert.match(nounHelp.stdout, /^\s+done <id\.\.\.>\s/m, "noun help lists done");
  const unknownVerb = spawnSync(ooBin, ["session-state", "nope"], opts);
  assert.equal(unknownVerb.status, 2, "unknown verb exits 2");
  assert.match(unknownVerb.stderr, /unknown verb "nope"/);

  const setupRequired = spawnSync(ooBin, ["-p", "what is happening?"], opts);
  assert.equal(setupRequired.status, 2, "fresh headless runs fail closed before model or daemon work");
  assert.match(setupRequired.stderr, /setup required.*run `oo`/is);
  assert.equal(setupRequired.stdout, "");
  markOnboarded(ooHome, { via: "e2e" });

  const barePrompt = spawnSync(ooBin, ["what", "changed"], opts);
  assert.equal(barePrompt.status, 2, `bare prompt exits 2 (got ${barePrompt.status}; stderr: ${barePrompt.stderr})`);
  assert.match(barePrompt.stderr, /unknown command "what".*oo -p "what changed"/, "bare prompt names -p");
  assert.equal(barePrompt.stdout, "", "bare prompt does not build a model session");

  for (const [argv, replacement] of [
    [["--json"], /oo session-state list --json/],
    [["--session-state"], /oo session-state list/],
    [["--done", "x"], /oo session-state done <id\.\.\.>/],
    [[["one", "shot"].join("-"), "what changed?"], /oo -p/],
    [[["one", "shot"].join(""), "what changed?"], /oo -p/],
  ] as const) {
    const removed = spawnSync(ooBin, [...argv], opts);
    assert.equal(removed.status, 2, `${argv.join(" ")} exits 2 (got ${removed.status}; stderr: ${removed.stderr})`);
    assert.match(removed.stderr, replacement, `${argv.join(" ")} names its replacement`);
    assert.equal(removed.stdout, "", `${argv.join(" ")} does not build a model session`);
  }

  const trailingSession = spawnSync(ooBin, ["-p", "hi", "--session"], opts);
  assert.equal(trailingSession.status, 2, `trailing --session exits 2 (got ${trailingSession.status}; stderr: ${trailingSession.stderr})`);
  assert.match(trailingSession.stderr, /--session needs an id or path/, "trailing --session names the missing value");
  assert.equal(trailingSession.stdout, "", "trailing --session exits before stdout/model work");

  const mixedInteractive = spawnSync(ooBin, ["--continue", "-i"], opts);
  assert.equal(mixedInteractive.status, 2, `mixed -i exits 2 (got ${mixedInteractive.status}; stderr: ${mixedInteractive.stderr})`);
  assert.match(mixedInteractive.stderr, /only valid by itself/, "-i with resume is rejected before agent setup");
  assert.equal(mixedInteractive.stdout, "", "mixed -i exits before stdout/model work");

  const missingSession = spawnSync(ooBin, ["--session", "nope123", "-p", "hi"], opts);
  assert.equal(missingSession.status, 2, `unknown --session exits 2 (got ${missingSession.status}; stderr: ${missingSession.stderr})`);
  assert.match(missingSession.stderr, /no oo session matching "nope123"/, "names the unmatched session ref");
  assert.equal(missingSession.stdout, "", "nothing on stdout for a bad session ref");

  // --done crosses the real client → gateway → state seam; no embedded state fallback.
  const { startDaemon } = await import("../daemon/runtime");
  daemon = await startDaemon({
    port: 0,
    dbPath: join(ooHome, "state.db"),
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60_000 },
    scheduler: { tickMs: 60_000 },
  });
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  daemon.state.recordObservation({
    id: "e2e-done-1", source: "claude", repo: "demo", app: "Claude CLI", topic: "ship it",
    lastRole: "user", working: false, secondsSinceLastMessage: 30, secondsSinceActivity: 30,
    createdAt: recent, lastMessageAt: recent,
  });
  const noIds = spawnSync(ooBin, ["session-state", "done"], opts);
  assert.equal(noIds.status, 2, `bare done exits 2 (got ${noIds.status}; stderr: ${noIds.stderr})`);
  assert.match(noIds.stderr, /expected <id\.\.\.>/, "bare done names the missing ids");

  const list = await runOo(["session-state", "list", "--json"]);
  assert.equal(list.status, 0, `session-state list exits 0 (stderr: ${list.stderr})`);
  const listed = JSON.parse(list.stdout) as Array<{ id: string }>;
  assert.deepEqual(listed.map((row) => row.id), ["e2e-done-1"], "the seeded row is current");
  assert.deepEqual(listed, daemon.state.listCurrentSessionState(), "list --json returns the GET /session-state rows");
  const listText = await runOo(["session-state", "list"]);
  assert.match(listText.stdout, /1\. .*e2e-done-1/, "text list shows a numbered row with its id");

  const done = await runOo(["session-state", "done", "e2e-done-1", "ghost-id"]);
  assert.equal(done.status, 1, `done with a ghost id exits 1 (got ${done.status}; stderr: ${done.stderr})`);
  const doneOut = JSON.parse((await runOo(["session-state", "done", "e2e-done-1", "--json"])).stdout) as { alreadyDoneIds: string[] };
  assert.deepEqual(doneOut.alreadyDoneIds, ["e2e-done-1"], "done --json returns the POST /done result");
  assert.match(done.stdout, /done\s+e2e-done-1/, "seeded thread marked done");
  assert.match(done.stdout, /missing\s+ghost-id/, "unknown id reported, not silently dropped");
} finally {
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo grammar: help, nouns, -p, session-state list/done over the Gateway; removed spellings and bad resume args exit 2\n");
