// Integration: the outside-agent skill links. Stale copies are replaced (and kept aside), every
// existing harness folder is linked, edits in the checkout show through the links, a moved
// checkout reads as dangling, and uninstall removes only what install created.
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkillLinks, skillLinkStatus, uninstallSkillLinks } from "./skill-links";

delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
const root = mkdtempSync(join(tmpdir(), "oo-skill-links-"));
const userHome = join(root, "home");
const ooHome = join(root, "oo-home");
const checkoutRoot = join(root, "checkout");
const skill = (dir: string, name: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
};

try {
  skill(join(checkoutRoot, "skills", "owner-operator"), "owner-operator", "v1");
  skill(join(userHome, ".agents", "skills", "owner-operator"), "owner-operator", "stale copy");
  skill(join(userHome, ".claude", "skills", "owner-operator"), "owner-operator", "stale copy");
  mkdirSync(join(userHome, ".codex", "skills"), { recursive: true });
  const options = { userHome, ooHome, checkoutRoot, now: () => new Date("2026-09-23T00:00:00.000Z") };

  const installed = installSkillLinks(options);
  assert.deepEqual(installed.map(({ label, action }) => [label, action]), [
    ["agents", "replaced-copy"], ["claude", "replaced-copy"], ["codex", "linked"], ["cursor", "skipped"],
  ], "every folder is reported linked or skipped");
  assert.match(installed[3]!.detail ?? "", /\.cursor\/skills does not exist/);
  const backup = join(ooHome, "skill-backups", "2026-09-23T00-00-00.000Z", "claude", "SKILL.md");
  assert.match(readFileSync(backup, "utf8"), /stale copy/, "the replaced copy is kept outside every skills folder");

  const claudeSkill = join(userHome, ".claude", "skills", "owner-operator", "SKILL.md");
  assert.match(readFileSync(claudeSkill, "utf8"), /v1/);
  skill(join(checkoutRoot, "skills", "owner-operator"), "owner-operator", "v2 after git pull");
  assert.match(readFileSync(claudeSkill, "utf8"), /v2 after git pull/, "checkout updates show through the link");
  assert.deepEqual(skillLinkStatus(options).map(({ label, state }) => [label, state]), [
    ["agents", "linked"], ["claude", "linked"], ["codex", "linked"], ["cursor", "no-folder"],
  ]);
  assert.deepEqual(installSkillLinks(options).slice(0, 3).map(({ action }) => action), ["already-linked", "already-linked", "already-linked"],
    "install is idempotent");

  renameSync(checkoutRoot, join(root, "moved-checkout"));
  assert.deepEqual(skillLinkStatus(options).map(({ label, state }) => [label, state]), [
    ["agents", "dangling"], ["claude", "dangling"], ["codex", "dangling"], ["cursor", "no-folder"],
  ], "a moved checkout reads as dangling");
  renameSync(join(root, "moved-checkout"), checkoutRoot);

  // A link someone else made is never replaced or removed.
  mkdirSync(join(userHome, ".cursor", "skills"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(userHome, ".cursor", "skills", "owner-operator"));
  assert.equal(installSkillLinks(options)[3]!.action, "skipped");
  const removed = uninstallSkillLinks(options);
  assert.deepEqual(removed.map(({ label, action }) => [label, action]), [
    ["agents", "removed"], ["claude", "removed"], ["codex", "removed"], ["cursor", "skipped"],
  ], "uninstall removes only the links install created");
  assert.equal(existsSync(join(userHome, ".claude", "skills", "owner-operator")), false);
  assert.ok(skillLinkStatus(options)[3]!.state === "dangling", "the foreign link is left in place");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — skill links: copies replaced, folders linked or skipped, pull-through, dangling on move, owned-only uninstall\n");
