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
