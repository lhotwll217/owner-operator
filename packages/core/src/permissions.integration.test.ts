import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureOwnerOperatorWorkspace, ownerOperatorPaths } from "./harness.mjs";
import { reconcilePermissionSettings, savePermissionMode } from "./permissions.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-permissions-"));
const paths = ownerOperatorPaths(ooHome);
const generatedReason = "Owner Operator privacy blacklist";

try {
  ensureOwnerOperatorWorkspace(ooHome);
  mkdirSync(dirname(paths.piPermissionConfig), { recursive: true });
  writeFileSync(paths.settings, JSON.stringify({ permissionMode: "ask" }));
  writeFileSync(paths.blacklist, JSON.stringify({ paths: [join(ooHome, "Private")], repos: [] }));
  writeFileSync(paths.piPermissionConfig, `{
    // Pi runtime settings remain user-owned.
    "debugLog": true,
    "yoloMode": false,
    "permission": {
      "custom_surface": { "private:*": "deny" },
      "bash": { "*": "deny", "git status": "allow" },
      "path": {
        "*": "ask",
        "*.env": "deny",
        "/previous/private": { "action": "deny", "reason": "${generatedReason}" }
      },
      "edit": { "*": "deny", "*.md": "allow" }
    }
  }`);

  const ask = reconcilePermissionSettings(ooHome);
  assert.equal(ask.debugLog, true, "unowned top-level extension config is preserved");
  assert.equal(ask.yoloMode, false, "commented JSONC config is parsed without losing runtime settings");
  assert.deepEqual(ask.permission.custom_surface, { "private:*": "deny" }, "custom surfaces are preserved");
  assert.deepEqual(ask.permission.bash, { "*": "ask", "git status": "allow" });
  assert.deepEqual(ask.permission.edit, { "*": "ask", "*.md": "allow" });
  assert.equal(ask.permission.path["*.env"], "deny", "owner-authored path rules are preserved");
  assert.equal(ask.permission.path["/previous/private"], undefined, "obsolete generated rules are removed");
  assert.deepEqual(ask.permission.path[join(ooHome, "Private")], { action: "deny", reason: generatedReason });
  assert.deepEqual(ask.permission.path[join(ooHome, "Private", "*")], { action: "deny", reason: generatedReason });

  writeFileSync(paths.blacklist, JSON.stringify({ paths: [join(ooHome, "Vault")], repos: [] }));
  const reconciled = reconcilePermissionSettings(ooHome);
  assert.equal(reconciled.permission.path[join(ooHome, "Private")], undefined);
  assert.deepEqual(reconciled.permission.path[join(ooHome, "Vault")], { action: "deny", reason: generatedReason });
  assert.equal(reconciled.permission.path["*.env"], "deny");

  const allow = savePermissionMode(ooHome, "allow");
  assert.equal(allow.permission["*"], "allow");
  assert.equal(allow.permission.bash["*"], "allow");
  assert.equal(allow.permission.bash["git status"], "allow");

  const readOnly = savePermissionMode(ooHome, "read-only");
  assert.equal(readOnly.permission["*"], "deny");
  assert.equal(readOnly.permission.read["*"], "allow");
  assert.equal(readOnly.permission.edit["*"], "deny");
  assert.equal(readOnly.permission.edit["*.md"], "allow", "advanced project/user rules remain user-owned");
  assert.equal(readOnly.permission.bash["*"], "deny");
  assert.deepEqual(JSON.parse(readFileSync(paths.piPermissionConfig, "utf8")), readOnly);

  const invalidConfig = "{ invalid permission config";
  writeFileSync(paths.piPermissionConfig, invalidConfig);
  assert.throws(() => reconcilePermissionSettings(ooHome), /invalid Pi permission config/);
  assert.equal(readFileSync(paths.piPermissionConfig, "utf8"), invalidConfig, "invalid config is never overwritten");

  process.stdout.write("ok — permissions: modes reconcile owned defaults without clobbering advanced Pi rules\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}
