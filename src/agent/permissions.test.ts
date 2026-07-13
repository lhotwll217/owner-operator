import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateOwnerOperatorToolCall } from "./permissions";

const root = mkdtempSync(join(tmpdir(), "oo-permissions-"));
const ooHome = join(root, "oo-home");
const task = join(root, "task");
const blocked = join(task, "Private");
mkdirSync(blocked, { recursive: true });
mkdirSync(ooHome, { recursive: true });
writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [blocked], repos: [] }));

const decide = (
  toolName: string,
  input: Record<string, unknown>,
  surface: "interactive" | "headless" = "interactive",
) => evaluateOwnerOperatorToolCall({ toolName, input, cwd: task, ooHome, surface });

try {
  assert.deepEqual(await decide("read", { path: "README.md" }), { action: "allow" });
  assert.deepEqual(await decide("bash", { command: "git status --short" }), { action: "allow" });
  assert.deepEqual(await decide("bash", { command: "rg TODO src" }), { action: "allow" });
  assert.deepEqual(
    await decide("bash", { command: 'node "$OO_INSTALL_ROOT/src/agent/skills/session-search/scripts/session-search.mjs" --query TODO' }, "headless"),
    { action: "allow" },
    "the bundled read-only session-search helper remains available headlessly",
  );

  assert.equal((await decide("edit", { path: "README.md" })).action, "ask");
  assert.equal((await decide("write", { path: "notes.md" }, "headless")).action, "deny");
  assert.equal((await decide("bash", { command: "rm notes.md" })).action, "ask");
  assert.equal((await decide("bash", { command: "git push origin main" }, "headless")).action, "deny");
  assert.equal((await decide("bash", { command: "python -c 'print(1)'" })).action, "ask", "unknown programs fail toward approval");

  for (const command of [
    `cat ${join(blocked, "secret.txt")}`,
    "rg secret Private",
    `bash -c "sed -n 1p ${join(blocked, "secret.txt")}"`,
    `echo leaked > ${join(blocked, "new.txt")}`,
  ]) {
    const decision = await decide("bash", { command });
    assert.equal(decision.action, "deny", `blacklist denies bash route: ${command}`);
    assert.match(decision.reason ?? "", /blacklist/i);
  }
  assert.equal((await decide("grep", { pattern: "secret", path: task })).action, "deny", "recursive raw tools cannot traverse a blacklisted child");
  assert.equal((await decide("read", { path: join(blocked, "secret.txt") })).action, "deny");

  process.stdout.write("ok — permission policy: allow/ask/deny with absolute blacklist\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
