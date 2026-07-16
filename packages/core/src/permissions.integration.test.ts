import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { ensureOwnerOperatorWorkspace, ownerOperatorPaths } from "./harness.mjs";
import { reconcilePermissionSettings, savePermissionMode } from "./permissions.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-permissions-"));
const paths = ownerOperatorPaths(ooHome);
const generatedReason = "Owner Operator privacy blacklist";
const privateTarget = join(ooHome, "Private-target");
const privateLink = join(ooHome, "Private");

try {
  ensureOwnerOperatorWorkspace(ooHome);
  mkdirSync(dirname(paths.piPermissionConfig), { recursive: true });
  mkdirSync(privateTarget, { recursive: true });
  symlinkSync(privateTarget, privateLink);
  const canonicalPrivateTarget = realpathSync.native(privateTarget);
  writeFileSync(paths.settings, JSON.stringify({ permissionMode: "ask" }));
  writeFileSync(paths.blacklist, JSON.stringify({ paths: [privateLink], repos: [] }));
  writeFileSync(paths.piPermissionConfig, `{
    // Pi runtime settings remain user-owned.
    "debugLog": true,
    "yoloMode": false,
    "permission": {
      "custom_surface": { "private:*": "deny" },
      "bash": {
        // Keep this command-specific exception.
        "git status": "allow",
        // Keep this default-policy explanation.
        "*": "deny"
      },
      "path": {
        "*": "ask",
        "/previous/private": { "action": "deny", "reason": "${generatedReason}" },
        // Keep this owner path-rule explanation.
        "*.env": "deny",
        "${privateLink}": "allow",
        "${canonicalPrivateTarget}": "allow",
        // Keep this trailing owner explanation.
        "/previous/last": { "action": "deny", "reason": "${generatedReason}" }
      },
      "edit": { "*": "deny", "*.md": "allow" }
    }
  }`);

  const ask = reconcilePermissionSettings(ooHome);
  const reconciledText = readFileSync(paths.piPermissionConfig, "utf8");
  assert.match(reconciledText, /Pi runtime settings remain user-owned/, "top-level JSONC comments survive reconciliation");
  assert.match(reconciledText, /Keep this command-specific exception/, "comments inside permission rules survive reconciliation");
  assert.match(reconciledText, /Keep this default-policy explanation/, "moving a wildcard preserves its comment");
  assert.match(reconciledText, /Keep this owner path-rule explanation/, "removing a stale generated rule preserves adjacent comments");
  assert.match(reconciledText, /Keep this trailing owner explanation/, "removing the last stale rule preserves its leading comment");
  assert.equal(ask.debugLog, true, "unowned top-level extension config is preserved");
  assert.equal(ask.yoloMode, false, "commented JSONC config is parsed without losing runtime settings");
  assert.deepEqual(ask.permission.custom_surface, { "private:*": "deny" }, "custom surfaces are preserved");
  assert.deepEqual(ask.permission.bash, { "*": "ask", "git status": "allow" });
  assert.deepEqual(ask.permission.edit, { "*": "ask", "*.md": "allow" });
  assert.deepEqual(ask.permission.mark_thread_done, { "*": "allow" });
  assert.deepEqual(ask.permission.schedule_prompt, { "*": "ask" });
  assert.deepEqual(ask.permission.manage_schedule, { "*": "ask" });
  assert.equal(ask.permission.path["*.env"], "deny", "owner-authored path rules are preserved");
  assert.equal(ask.permission.path["/previous/private"], undefined, "obsolete generated rules are removed");
  assert.equal(ask.permission.path["/previous/last"], undefined);
  assert.equal(ask.permission.path[privateLink], "allow", "specific global rules override generated Pi path rules");
  assert.equal(ask.permission.path[canonicalPrivateTarget], "allow");
  assert.deepEqual(ask.permission.path[join(privateLink, "*")], { action: "deny", reason: generatedReason });
  assert.deepEqual(ask.permission.path[join(canonicalPrivateTarget, "*")], { action: "deny", reason: generatedReason });
  const parsedAsk = parse(reconciledText);
  assert.equal(Object.keys(parsedAsk.permission.bash)[0], "*", "managed wildcard defaults precede specific Pi rules");
  assert.equal(Object.keys(parsedAsk.permission.path)[0], "*", "the path wildcard remains the broadest rule");
  assert.ok(
    Object.keys(parsedAsk.permission.path).indexOf(join(privateLink, "*")) <
      Object.keys(parsedAsk.permission.path).indexOf("*.env"),
    "generated path rules precede owner-authored overrides",
  );

  writeFileSync(paths.blacklist, JSON.stringify({ paths: [join(ooHome, "Vault")], repos: [] }));
  const reconciled = reconcilePermissionSettings(ooHome);
  assert.equal(reconciled.permission.path[privateLink], "allow");
  assert.equal(reconciled.permission.path[canonicalPrivateTarget], "allow");
  assert.equal(reconciled.permission.path[join(privateLink, "*")], undefined);
  assert.equal(reconciled.permission.path[join(canonicalPrivateTarget, "*")], undefined);
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
  assert.equal(readOnly.permission.mark_thread_done["*"], "deny");
  assert.equal(readOnly.permission.schedule_prompt["*"], "deny");
  assert.equal(readOnly.permission.manage_schedule["*"], "deny");
  assert.equal(readOnly.permission.bash["*"], "deny");
  assert.deepEqual(parse(readFileSync(paths.piPermissionConfig, "utf8")), readOnly);

  const invalidConfig = "{ invalid permission config";
  writeFileSync(paths.piPermissionConfig, invalidConfig);
  assert.throws(() => reconcilePermissionSettings(ooHome), /invalid Pi permission config/);
  assert.equal(readFileSync(paths.piPermissionConfig, "utf8"), invalidConfig, "invalid config is never overwritten");

  process.stdout.write("ok — permissions: modes reconcile owned defaults without clobbering advanced Pi rules\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}
