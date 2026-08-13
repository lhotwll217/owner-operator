/** The `codex app-server` client against real child processes: the documented request order over
 * real JSON-RPC framing, and the guarantee that no app-server outlives the observation that
 * spawned it — including one that ignores SIGTERM. */

import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexAppServerPayloads } from "./harness-details";

const TIMEOUT_MS = 2_000;
const KILL_GRACE_MS = 200;

/** Answers every request with the method it was asked for and whether `initialized` had already
 * arrived, so the client's request order is observable from the results alone. */
const RESPONSIVE_SERVER = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
let index = 0;
let initializedSeen = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") { initializedSeen = true; return; }
  const result = { method: message.method, index: index++, initializedSeen };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

const PAGED_SERVER = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
const mode = process.argv[3];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  let result = { method: message.method };
  if (message.method === "model/list") {
    const cursor = message.params?.cursor ?? null;
    if (mode === "failure" && cursor === "page-2") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "page two failed" } }) + "\\n");
      return;
    }
    result = cursor === null
      ? { data: [{ id: "first" }], nextCursor: "page-2" }
      : { data: [{ id: "second" }], nextCursor: mode === "loop" ? "page-2" : null };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

/** Never answers and refuses SIGTERM: the shape of a hung app-server. */
const STUBBORN_SERVER = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

const dir = mkdtempSync(join(tmpdir(), "oo-codex-app-server-"));

const server = (name: string, source: string): { args: string[]; pid: () => number } => {
  const scriptPath = join(dir, `${name}.mjs`);
  const pidPath = join(dir, `${name}.pid`);
  writeFileSync(scriptPath, source);
  return {
    args: [scriptPath, pidPath],
    pid: () => Number.parseInt(readFileSync(pidPath, "utf8"), 10),
  };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  // --- The documented request order holds over real JSON-RPC framing ---------------------------

  const responsive = server("responsive", RESPONSIVE_SERVER);
  const payloads = await readCodexAppServerPayloads({
    command: process.execPath,
    args: responsive.args,
    timeoutMs: TIMEOUT_MS,
    killGraceMs: KILL_GRACE_MS,
  });
  assert.deepEqual(payloads, {
    account: { method: "account/read", index: 1, initializedSeen: true },
    rateLimits: { method: "account/rateLimits/read", index: 2, initializedSeen: true },
    models: { method: "model/list", index: 3, initializedSeen: true },
  }, "the catalog is requested last, after initialize and initialized");
  assert.equal(
    alive(responsive.pid()),
    false,
    "a finished observation leaves no app-server behind",
  );

  // --- model/list follows every cursor and fails closed on broken pagination -------------------

  const paged = server("paged", PAGED_SERVER);
  paged.args.push("complete");
  const complete = await readCodexAppServerPayloads({
    command: process.execPath, args: paged.args, timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS,
  });
  assert.deepEqual(complete.models, {
    data: [{ id: "first" }, { id: "second" }], nextCursor: null,
  }, "all captured model pages are combined in advertised order");

  for (const [mode, message] of [["failure", /page two failed/], ["loop", /pagination loop/]] as const) {
    const broken = server(`paged-${mode}`, PAGED_SERVER);
    broken.args.push(mode);
    await assert.rejects(readCodexAppServerPayloads({
      command: process.execPath, args: broken.args, timeoutMs: TIMEOUT_MS, killGraceMs: KILL_GRACE_MS,
    }), message, `${mode} pagination cannot return a partial successful catalog`);
    assert.equal(alive(broken.pid()), false, `${mode} pagination still terminates its app-server`);
  }

  // --- A closed request pipe rejects in-flight work without becoming an uncaught exception -----

  const closedStdinPidPath = join(dir, "closed-stdin.pid");
  const closedStdin = {
    args: ["-c", 'echo "$$" > "$1"; IFS= read -r _line; exec 0<&-; printf \'{"jsonrpc":"2.0","id":0,"result":{}}\\n\'; while :; do :; done', "_", closedStdinPidPath],
    pid: () => Number.parseInt(readFileSync(closedStdinPidPath, "utf8"), 10),
  };
  await assert.rejects(readCodexAppServerPayloads({
    command: "/bin/sh",
    args: closedStdin.args,
    timeoutMs: TIMEOUT_MS,
    killGraceMs: KILL_GRACE_MS,
  }), /EPIPE|stdin|stream|pipe/i, "a closed app-server stdin rejects the observation through the client boundary");
  assert.equal(alive(closedStdin.pid()), false, "stdin failure still terminates the app-server child");

  // --- A hung app-server is timed out and killed, not left running ------------------------------

  const stubborn = server("stubborn", STUBBORN_SERVER);
  const startedAt = Date.now();
  await assert.rejects(
    readCodexAppServerPayloads({
      command: process.execPath,
      args: stubborn.args,
      timeoutMs: TIMEOUT_MS,
      killGraceMs: KILL_GRACE_MS,
    }),
    /codex app-server timed out/,
    "an app-server that never answers fails the read rather than hanging it",
  );
  const stubbornPid = stubborn.pid();
  assert.equal(
    alive(stubbornPid),
    false,
    "an app-server that ignores SIGTERM is escalated to SIGKILL before the read returns",
  );
  assert.ok(
    Date.now() - startedAt >= TIMEOUT_MS + KILL_GRACE_MS,
    "the read waits out the SIGTERM grace before escalating, rather than killing outright",
  );

  process.stdout.write("ok — codex app-server reads in order and never outlives its observation\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
