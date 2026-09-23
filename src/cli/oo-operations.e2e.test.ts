// e2e: `oo db` and `oo schedules` against a hermetic daemon. Each verb must print exactly what
// its Gateway route returns, and Gateway validation errors must surface verbatim.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(noFrom.status, 2, "create without --from is a usage error");
} finally {
  await daemon?.close();
  rmSync(ooHome, { recursive: true, force: true });
}

process.stdout.write("ok — oo db and schedules return their routes' payloads; write and trigger errors surface from the Gateway\n");
