// Integration: the outside-agent skill links. Stale copies are replaced (and kept aside), every
// existing harness folder is linked, edits in the checkout show through the links, a moved
// checkout reads as dangling, and uninstall removes only what install created.
import assert from "node:assert";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  // Reinstalling from the moved checkout repairs the links oo made.
  const moved = { ...options, checkoutRoot: join(root, "moved-checkout") };
  assert.deepEqual(installSkillLinks(moved).slice(0, 3).map(({ action }) => action), ["linked", "already-linked", "already-linked"],
    "the canonical link is repointed and the harness links resolve through it again");
  assert.match(readFileSync(claudeSkill, "utf8"), /v2 after git pull/);
  renameSync(join(root, "moved-checkout"), checkoutRoot);
  assert.equal(installSkillLinks(options)[0]!.action, "linked", "and back again");

  // A link the owner repointed is theirs: reinstall and uninstall leave it alone.
  const ownerSkill = join(root, "owner-skill");
  mkdirSync(ownerSkill);
  const claudeLink = join(userHome, ".claude", "skills", "owner-operator");
  unlinkSync(claudeLink);
  symlinkSync(ownerSkill, claudeLink);
  assert.equal(installSkillLinks(options)[1]!.action, "skipped");
  assert.equal(readlinkSync(claudeLink), ownerSkill, "reinstall keeps the owner's link");
  assert.equal(uninstallSkillLinks(options)[1]!.action, "skipped");
  assert.equal(readlinkSync(claudeLink), ownerSkill, "uninstall keeps the owner's link");
  unlinkSync(claudeLink);
  installSkillLinks(options);

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
  // An unrelated canonical entry is skipped, and no harness is linked to it.
  const otherHome = join(root, "other-home");
  skill(join(otherHome, ".agents", "skills", "owner-operator"), "something-else", "not ours");
  mkdirSync(join(otherHome, ".claude", "skills"), { recursive: true });
  const unrelated = installSkillLinks({ ...options, userHome: otherHome, ooHome: join(root, "other-oo") });
  assert.deepEqual(unrelated.map(({ action }) => action), ["skipped", "skipped", "skipped", "skipped"]);
  assert.match(unrelated[1]!.detail ?? "", /does not resolve to/);
  assert.equal(lstatSync(join(otherHome, ".claude", "skills")).isDirectory(), true);
  assert.equal(existsSync(join(otherHome, ".claude", "skills", "owner-operator")), false, "no harness link to a foreign skill");
  // A folder that fails mid-install is reported, the rest still link, and every link made is
  // recorded before it exists, so uninstall can remove it.
  const failHome = join(root, "fail-home");
  const failOo = join(root, "fail-oo");
  mkdirSync(join(failHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(failHome, ".cursor"), { recursive: true });
  writeFileSync(join(failHome, ".cursor", "skills"), "a file where the skills folder should be");
  const partial = installSkillLinks({ ...options, userHome: failHome, ooHome: failOo });
  assert.deepEqual(partial.map(({ label, action }) => [label, action]), [
    ["agents", "linked"], ["claude", "linked"], ["codex", "skipped"], ["cursor", "skipped"],
  ]);
  assert.match(partial[3]!.detail ?? "", /^failed: /);
  const recorded = (JSON.parse(readFileSync(join(failOo, "skill-links.json"), "utf8")) as { links: Array<{ label: string }> }).links;
  assert.deepEqual(recorded.map(({ label }) => label).sort(), ["agents", "claude"], "the links made are owned on disk");
  assert.deepEqual(uninstallSkillLinks({ ...options, userHome: failHome, ooHome: failOo }).filter(({ action }) => action === "removed").map(({ label }) => label),
    ["agents", "claude"]);

  // Uninstall under a different CLAUDE_CONFIG_DIR still removes the link oo made in the old one.
  const envHome = join(root, "env-home");
  const envOo = join(root, "env-oo");
  mkdirSync(join(envHome, ".claude", "skills"), { recursive: true });
  installSkillLinks({ ...options, userHome: envHome, ooHome: envOo });
  process.env.CLAUDE_CONFIG_DIR = join(root, "another-claude-home");
  try {
    const removed = uninstallSkillLinks({ ...options, userHome: envHome, ooHome: envOo });
    assert.ok(removed.some(({ path, action }) => path === join(envHome, ".claude", "skills", "owner-operator") && action === "removed"),
      "the recorded link in the previous harness home is removed");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  assert.equal(existsSync(join(envHome, ".claude", "skills", "owner-operator")), false);
  assert.deepEqual((JSON.parse(readFileSync(join(envOo, "skill-links.json"), "utf8")) as { links: unknown[] }).links, []);
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — skill links: copies replaced, folders linked or skipped, pull-through, dangling on move, owned-only uninstall\n");
