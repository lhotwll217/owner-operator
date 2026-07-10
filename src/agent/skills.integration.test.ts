import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { ownerOperatorResourceLoaderOptions } from "./skills";

const dir = mkdtempSync(join(tmpdir(), "oo-skills-"));
const cwd = join(dir, "project");
const agentDir = join(dir, "agent");

const writeSkill = (root: string, name: string): void => {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n`,
  );
};

try {
  writeSkill(join(cwd, ".pi", "skills"), "project-helper");
  writeSkill(join(agentDir, "skills"), "user-helper");

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    ...ownerOperatorResourceLoaderOptions(),
  });
  await loader.reload();

  const { skills, diagnostics } = loader.getSkills();
  const names = skills.map((skill) => skill.name);
  assert.ok(names.includes("session-search"), "Owner Operator injects its bundled transcript skill");
  assert.ok(names.includes("project-helper"), "normal Pi project skills remain available");
  assert.ok(names.includes("user-helper"), "normal Pi user skills remain available");
  assert.ok(
    skills.find((skill) => skill.name === "session-search")?.filePath.endsWith("/src/agent/skills/session-search/SKILL.md"),
    "the catalog points at the regular bundled SKILL.md",
  );
  assert.ok(
    !diagnostics.some((diagnostic) => diagnostic.path?.endsWith("/src/agent/skills/session-search/SKILL.md")),
    "the bundled skill passes Pi validation",
  );

  process.stdout.write("ok — Owner Operator skills use Pi's normal resource-loader catalog\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
