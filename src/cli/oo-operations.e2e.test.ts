// e2e: `oo db` and `oo schedules` against a hermetic daemon. Each verb must print exactly what
// its Gateway route returns, and Gateway validation errors must surface verbatim.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonInfo } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";
import { SCHEMA_DOCS } from "../state/schema-docs";

const ooBin = join(repoRoot, "oo");
const ooHome = mkdtempSync(join(tmpdir(), "oo-ops-e2e-"));
process.env.OO_HOME = ooHome;
let daemon: Awaited<ReturnType<typeof import("../daemon/runtime")["startDaemon"]>> | null = null;

const runOo = async (args: readonly string[], stdin?: string): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(ooBin, args, { cwd: repoRoot, env: { ...process.env, OO_HOME: ooHome } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });

/** Spawn oo with its stdout paused for a second, so the pipe fills while the CLI writes. */
const runOoSlowReader = async (args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(ooBin, args, { cwd: repoRoot, env: { ...process.env, OO_HOME: ooHome } });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.pause();
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 1_000);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout: Buffer.concat(chunks).toString("utf8"), stderr }));
    child.stdin.end();
  });

const route = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
  const info = JSON.parse(readFileSync(join(ooHome, "daemon.json"), "utf8")) as DaemonInfo;
  const response = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${info.authToken}`, "content-type": "application/json" },
  });
  return { status: response.status, body: await response.json() };
};

const cliJson = async (args: readonly string[], stdin?: string): Promise<unknown> => {
  const result = await runOo([...args, "--json"], stdin);
  assert.equal(result.status, 0, `oo ${args.join(" ")} exits 0 (stderr: ${result.stderr})`);
  return JSON.parse(result.stdout);
};

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
  const query = (body: unknown) => route("/query-database", { method: "POST", body: JSON.stringify(body) });

  // db: each verb returns the route's payload.
  assert.deepEqual(await cliJson(["db", "tables"]), (await query({ action: "list_tables" })).body, "db tables = list_tables");
  const described = await cliJson(["db", "describe", "agent_runs"]) as { description: string; columns: Array<{ name: string; description: string }> };
  assert.deepEqual(described, (await query({ action: "describe_table", table: "agent_runs" })).body, "db describe = describe_table");
  const docs = SCHEMA_DOCS.find((table) => table.name === "agent_runs")!;
  assert.equal(described.description, docs.description, "describe shows the schema-docs table purpose");
  for (const column of docs.columns) {
    assert.equal(described.columns.find((c) => c.name === column.name)?.description, column.description, `describe documents ${column.name}`);
  }
  const describeText = await runOo(["db", "describe", "agent_runs"]);
  assert.ok(describeText.stdout.includes(docs.columns[0]!.description), "text describe shows schema-docs column text");
  const sql = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 2";
  assert.deepEqual(await cliJson(["db", "query", sql]), (await query({ action: "query", sql })).body, "db query = query");
  // A payload far larger than the pipe buffer, read only after the CLI has finished writing,
  // must arrive whole: exit waits for stdout to drain.
  const bigSql = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) SELECT i, printf('%.5000c', 'x') AS pad FROM n";
  const slow = await runOoSlowReader(["db", "query", bigSql, "--json"]);
  assert.equal(slow.status, 0, slow.stderr);
  assert.deepEqual(JSON.parse(slow.stdout), (await query({ action: "query", sql: bigSql })).body, "a slow reader receives the whole payload");
  assert.ok(slow.stdout.length > 1_000_000);

  const write = await runOo(["db", "query", "DELETE FROM agent_runs", "--json"]);
  const writeRoute = await query({ action: "query", sql: "DELETE FROM agent_runs" });
  assert.equal(write.status, 1, "a write statement fails");
  assert.deepEqual(JSON.parse(write.stderr), { status: writeRoute.status, ...(writeRoute.body as object) }, "write fails with the Gateway's structured error");
  assert.match(write.stderr, /readonly/i);

  // schedules: create → list → update → run → delete round trip, each against the route.
  const input = {
    name: "e2e echo",
    enabled: true,
    trigger: { kind: "every", everyMs: 3_600_000, anchorMs: 0 },
    payload: { kind: "command", argv: ["/bin/echo", "OO_SCHEDULE_OK"] },
    cwd: ooHome,
    timeoutSeconds: 30,
  };
  const inputFile = join(ooHome, "schedule.json");
  writeFileSync(inputFile, JSON.stringify(input));
  const created = await cliJson(["schedules", "create", "--from", inputFile]) as { id: string; name: string };
  assert.equal(created.name, "e2e echo");
  assert.deepEqual(await cliJson(["schedules", "list"]), (await route("/schedules")).body, "list = GET /schedules");
  assert.deepEqual((await route("/schedules")).body, [created], "created record is the stored record");
  const updated = await cliJson(["schedules", "update", created.id, "--from", "-"], JSON.stringify({ ...input, name: "e2e renamed" })) as { name: string; revision: number };
  assert.equal(updated.name, "e2e renamed", "update reads the body from stdin");
  assert.deepEqual(((await route("/schedules")).body as unknown[])[0], updated, "updated record is the stored record");
  const run = await cliJson(["schedules", "run", created.id]) as { id: string; scheduleId: string; trigger: string };
  assert.equal(run.scheduleId, created.id);
  assert.equal(run.trigger, "manual");
  assert.deepEqual(await cliJson(["schedules", "delete", created.id]), { ok: true }, "delete = DELETE route body");
  assert.deepEqual((await route("/schedules")).body, [], "the schedule is gone");

  // Text carries the whole route record: parsing it back gives the record, so a changed
  // interval, argument list, or timeout is visible without --json.
  const parseRecord = (text: string): Record<string, unknown> => Object.fromEntries(text.trim().split("\n").map((line) => {
    const at = line.indexOf(": ");
    return [line.slice(0, at), JSON.parse(line.slice(at + 2))];
  }));
  const textInput = { ...input, name: "e2e text" };
  const textCreated = await runOo(["schedules", "create", "--from", "-"], JSON.stringify(textInput));
  const textRecord = parseRecord(textCreated.stdout) as { id: string };
  assert.deepEqual(textRecord, ((await route("/schedules")).body as Array<{ id: string }>).find((s) => s.id === textRecord.id),
    "create text parses back to the stored record");
  const changed = { ...textInput, trigger: { kind: "every", everyMs: 7_200_000, anchorMs: 0 }, payload: { kind: "command", argv: ["/bin/echo", "changed"] }, timeoutSeconds: 90 };
  const textUpdated = parseRecord((await runOo(["schedules", "update", textRecord.id, "--from", "-"], JSON.stringify(changed))).stdout);
  assert.deepEqual([textUpdated.trigger, textUpdated.payload, textUpdated.timeoutSeconds], [changed.trigger, changed.payload, 90],
    "update text shows the changed interval, arguments, and timeout");
  assert.deepEqual(textUpdated, ((await route("/schedules")).body as Array<{ id: string }>).find((s) => s.id === textRecord.id));
  const listedText = (await runOo(["schedules", "list"])).stdout.trim().split("\n\n").map(parseRecord);
  assert.deepEqual(listedText, (await route("/schedules")).body, "list text parses back to GET /schedules");
  const textRun = parseRecord((await runOo(["schedules", "run", textRecord.id])).stdout);
  assert.deepEqual(Object.keys(textRun), Object.keys(run), "run text carries every run-record field");
  assert.equal(textRun.scheduleId, textRecord.id);
  const deletedText = await runOo(["schedules", "delete", textRecord.id]);
  assert.equal(deletedText.status, 0, deletedText.stderr);
  assert.deepEqual(parseRecord(deletedText.stdout), { ok: true }, "delete text parses back to the DELETE route's body");

  const missing = await runOo(["schedules", "delete", created.id, "--json"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stderr), { status: 404, error: `no such schedule: ${created.id}` });

  const invalid = { ...input, trigger: { kind: "every", everyMs: 5, anchorMs: 0 } };
  const invalidRoute = await route("/schedules", { method: "POST", body: JSON.stringify(invalid) });
  const invalidCli = await runOo(["schedules", "create", "--from", "-"], JSON.stringify(invalid));
  assert.equal(invalidCli.status, 1);
  assert.equal(invalidCli.stderr, `oo: ${(invalidRoute.body as { error: string }).error}\n`, "trigger validation error is verbatim");
  assert.match(invalidCli.stderr, /everyMs must be an integer of at least 1000/);

  const noFrom = await runOo(["schedules", "create"]);
  assert.equal(noFrom.status, 2, "create without --from or flags is a usage error");

  // disable: the stored record comes back with enabled false and every other input field kept.
  const toDisable = await cliJson(["schedules", "create", "--from", "-"], JSON.stringify({ ...input, name: "e2e disable" })) as { id: string };
  const disabled = await cliJson(["schedules", "disable", toDisable.id]) as Record<string, unknown>;
  const storedDisabled = ((await route("/schedules")).body as Array<Record<string, unknown>>).find((s) => s.id === toDisable.id);
  assert.deepEqual(disabled, storedDisabled, "disable prints the stored record");
  assert.equal(disabled.enabled, false);
  for (const field of ["name", "trigger", "payload", "cwd", "timeoutSeconds"] as const) {
    assert.deepEqual(disabled[field], field === "name" ? "e2e disable" : input[field], `disable keeps ${field}`);
  }
  const disabledText = await runOo(["schedules", "disable", toDisable.id]);
  assert.equal(disabledText.status, 0, disabledText.stderr);
  assert.deepEqual(parseRecord(disabledText.stdout),
    ((await route("/schedules")).body as Array<{ id: string }>).find((s) => s.id === toDisable.id), "disable text parses back to the stored record");
  const disableMissing = await runOo(["schedules", "disable", "no-such-id", "--json"]);
  assert.equal(disableMissing.status, 1, "disabling an unknown id fails");
  assert.deepEqual(JSON.parse(disableMissing.stderr), { error: "no such schedule: no-such-id" });
  await cliJson(["schedules", "delete", toDisable.id]);

  // create from flags: a prompt schedule without a JSON body, with the retired schedule tool's defaults
  // (the caller's cwd, a 1800 s timeout, an every-anchor of now).
  const callerCwd = realpathSync(repoRoot);
  const stored = async (id: string) => ((await route("/schedules")).body as Array<{ id: string }>).find((s) => s.id === id);
  const beforeEvery = Date.now();
  const every = await cliJson(["schedules", "create", "--name", "e2e every", "--prompt", "Review the backlog.", "--every", "90m", "--tools", "read,bash"]) as {
    id: string; trigger: { anchorMs: number };
  };
  assert.deepEqual(every, await stored(every.id), "flag create prints the stored record");
  assert.ok(every.trigger.anchorMs >= beforeEvery && every.trigger.anchorMs <= Date.now(), "every anchors at creation time");
  const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, nextRunAt: _nextRunAt, ...everyInput } = every as unknown as Record<string, unknown>;
  assert.deepEqual(everyInput, {
    name: "e2e every",
    enabled: true,
    trigger: { kind: "every", everyMs: 5_400_000, anchorMs: every.trigger.anchorMs },
    payload: { kind: "prompt", prompt: "Review the backlog.", toolsAllow: ["read", "bash"] },
    cwd: callerCwd,
    timeoutSeconds: 1_800,
  }, "flag create sends the POST /schedules body the retired schedule tool sent");

  const at = "2099-01-02T03:04:05.000Z";
  const atText = await runOo(["schedules", "create", "--name", "e2e at", "--prompt", "p", "--at", at, "--cwd", "src", "--timeout", "60"]);
  assert.equal(atText.status, 0, atText.stderr);
  const atRecord = parseRecord(atText.stdout) as { id: string; trigger: unknown; cwd: string; timeoutSeconds: number; payload: unknown };
  assert.deepEqual(atRecord, await stored(atRecord.id), "flag create text parses back to the stored record");
  assert.deepEqual([atRecord.trigger, atRecord.cwd, atRecord.timeoutSeconds, atRecord.payload],
    [{ kind: "at", at }, join(callerCwd, "src"), 60, { kind: "prompt", prompt: "p" }], "--cwd resolves against the caller's cwd; no --tools leaves toolsAllow unset");
  const cron = await cliJson(["schedules", "create", "--name", "e2e cron", "--prompt", "p", "--cron", "0 9 * * 1-5", "--tz", "Europe/Helsinki"]) as { id: string; trigger: unknown };
  assert.deepEqual(cron.trigger, { kind: "cron", expression: "0 9 * * 1-5", timeZone: "Europe/Helsinki" });
  const needsYou = await cliJson(["schedules", "create", "--name", "e2e needs", "--prompt", "p", "--needs-you", "--tools", ""]) as { id: string; trigger: unknown; payload: unknown };
  assert.deepEqual([needsYou.trigger, needsYou.payload], [{ kind: "needs-you" }, { kind: "prompt", prompt: "p", toolsAllow: [] }], "an empty --tools allows no tools");
  for (const durationCase of [["90s", 90_000], ["2h", 7_200_000], ["1d", 86_400_000]] as const) {
    const created = await cliJson(["schedules", "create", "--name", `e2e every ${durationCase[0]}`, "--prompt", "p", "--every", durationCase[0]]) as { id: string; trigger: { everyMs: number } };
    assert.equal(created.trigger.everyMs, durationCase[1], `--every ${durationCase[0]}`);
    await cliJson(["schedules", "delete", created.id]);
  }
  for (const id of [every.id, atRecord.id, cron.id, needsYou.id]) await cliJson(["schedules", "delete", id]);

  const base = ["schedules", "create", "--name", "n", "--prompt", "p"];
  for (const [args, why] of [
    [[...base, "--every", "1h", "--from", inputFile], "--from with flags"],
    [base, "no trigger"],
    [[...base, "--every", "1h", "--at", at], "two triggers"],
    [[...base, "--cron", "0 9 * * *"], "--cron without --tz"],
    [[...base, "--every", "1h", "--tz", "Europe/Helsinki"], "--tz without --cron"],
    [[...base, "--every", "5x"], "an unknown duration unit"],
    [[...base, "--every", "1h", "--tools", "read,nope"], "an unknown tool id"],
    [[...base, "--every", "1h", "--timeout", "0"], "a non-positive timeout"],
    [["schedules", "create", "--name", "n", "--every", "1h"], "no --prompt"],
    [["schedules", "create", "--prompt", "p", "--every", "1h"], "no --name"],
  ] as const) {
    const usage = await runOo(args);
    assert.equal(usage.status, 2, `${why} is a usage error (stderr: ${usage.stderr})`);
  }
  const unknownTool = await runOo([...base, "--every", "1h", "--tools", "read,nope"]);
  assert.match(unknownTool.stderr, /unknown tool "nope"/, "an unknown tool is named");
  assert.deepEqual((await route("/schedules")).body, [], "no usage error created a schedule");
} finally {
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo db and schedules return their routes' payloads; write and trigger errors surface from the Gateway\n");
