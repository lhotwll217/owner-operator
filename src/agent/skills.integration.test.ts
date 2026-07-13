import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { ensureOwnerOperatorWorkspace, ownerOperatorPaths, saveHarnessSettings } from "@owner-operator/core";
import { ownerOperatorResourceLoaderOptions } from "./skills";

const dir = mkdtempSync(join(tmpdir(), "oo-skills-"));
const cwd = join(dir, "task");
const agentDir = join(dir, "ambient-pi");
const ooHome = join(dir, "oo-home");
const personalSkills = join(dir, "personal-skills");

const writeSkill = (root: string, name: string): void => {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`);
};

const load = async (): Promise<DefaultResourceLoader> => {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...ownerOperatorResourceLoaderOptions({ ooHome, personalSkillsRoot: personalSkills }),
  });
  await loader.reload();
  return loader;
};

try {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeSkill(join(cwd, ".pi", "skills"), "project-helper");
  writeSkill(join(agentDir, "skills"), "pi-user-helper");
  writeSkill(paths.workspaceSkills, "workspace-helper");
  writeSkill(personalSkills, "calendar");
  writeSkill(personalSkills, "mail");
  writeFileSync(paths.workspaceInstructions, "Only workspace instructions.\n");

  const isolated = await load();
  const isolatedNames = isolated.getSkills().skills.map((skill) => skill.name);
  assert.ok(isolatedNames.includes("session-search"), "bundled Owner Operator skills are loaded");
  assert.ok(isolatedNames.includes("workspace-helper"), "workspace skills are loaded");
  assert.ok(!isolatedNames.includes("project-helper"), "task .pi skills are absent");
  assert.ok(!isolatedNames.includes("pi-user-helper"), "Pi user skills are absent");
  assert.ok(!isolatedNames.includes("calendar"), "personal Agent Skills are opt-in");
  assert.deepEqual(isolated.getAgentsFiles().agentsFiles, [{
    path: ownerOperatorPaths(ooHome).workspaceInstructions,
    content: "Only workspace instructions.\n",
  }], "only the exact workspace AGENTS.md is context");
  assert.equal(isolated.getExtensions().extensions.length, 0, "ambient extensions are absent");
  assert.equal(isolated.getPrompts().prompts.length, 0, "ambient prompt templates are absent");
  assert.equal(isolated.getThemes().themes.length, 0, "ambient themes are absent");

  saveHarnessSettings(ooHome, { skillPolicy: { mode: "allowlist", allowlist: ["calendar"] } });
  const selected = await load();
  const selectedNames = selected.getSkills().skills.map((skill) => skill.name);
  assert.ok(selectedNames.includes("calendar"), "selected personal skill is loaded");
  assert.ok(!selectedNames.includes("mail"), "unselected personal skill stays absent");

  saveHarnessSettings(ooHome, { skillPolicy: { mode: "all-personal", allowlist: [] } });
  const allPersonal = await load();
  const allNames = allPersonal.getSkills().skills.map((skill) => skill.name);
  assert.ok(allNames.includes("calendar") && allNames.includes("mail"), "all personal skills require explicit policy");

  process.stdout.write("ok — Owner Operator loads only owned and explicitly selected resources\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
