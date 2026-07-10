// Unit: blacklist-aware raw file tool overrides reject blocked paths before pi's built-ins
// execute, covering the read/grep/find/ls gap on every surface that exposes those names.

import assert from "node:assert";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlacklistAwareFileTools, createOwnerOperatorBashTool } from "./privacy-tools";

const root = mkdtempSync(join(tmpdir(), "oo-privacy-tools-"));
const ooHome = join(root, "oo-home");
const publicDir = join(root, "public");
const privateDir = join(root, "Private");
const privateFile = join(privateDir, "secret.txt");
const linkedSecret = join(publicDir, "linked-secret.txt");

process.env.OO_HOME = ooHome;

try {
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(ooHome, { recursive: true });
    await fs.mkdir(publicDir, { recursive: true });
    await fs.mkdir(privateDir, { recursive: true });
  });
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateDir], repos: [] }));
  writeFileSync(privateFile, "SECRET\n");
  symlinkSync(privateFile, linkedSecret);

  const tools = new Map(createBlacklistAwareFileTools().map((tool) => [tool.name, tool]));
  const ctx = { cwd: publicDir } as any;

  await assert.rejects(
    () => createOwnerOperatorBashTool().execute(
      "bash-1",
      { command: "cat", args: [privateFile] },
      undefined,
      undefined,
      ctx,
    ),
    /only runs the session-search skill helper/,
    "bash cannot execute arbitrary commands or read paths directly",
  );

  await assert.rejects(
    () => tools.get("read")!.execute("read-1", { path: privateFile }, undefined, undefined, ctx),
    /blacklisted/,
    "read blocks an absolute path inside a blacklisted tree",
  );
  await assert.rejects(
    () => tools.get("read")!.execute("read-2", { path: linkedSecret }, undefined, undefined, ctx),
    /blacklisted/,
    "read resolves symlinks before allowing access",
  );
  await assert.rejects(
    () => tools.get("grep")!.execute("grep-1", { pattern: "SECRET", path: privateDir }, undefined, undefined, ctx),
    /blacklisted/,
    "grep blocks a blacklisted search root",
  );
  await assert.rejects(
    () => tools.get("find")!.execute("find-1", { pattern: "*", path: privateDir }, undefined, undefined, ctx),
    /blacklisted/,
    "find blocks a blacklisted search root",
  );
  await assert.rejects(
    () => tools.get("ls")!.execute("ls-1", { path: privateDir }, undefined, undefined, ctx),
    /blacklisted/,
    "ls blocks a blacklisted directory",
  );
  await assert.rejects(
    () => tools.get("grep")!.execute("grep-2", { pattern: "SECRET", path: root }, undefined, undefined, ctx),
    /would traverse blacklisted path/,
    "grep blocks a parent search root that would recurse into a blacklisted tree",
  );
  await assert.rejects(
    () => tools.get("find")!.execute("find-2", { pattern: "*", path: root }, undefined, undefined, ctx),
    /would traverse blacklisted path/,
    "find blocks a parent search root that would recurse into a blacklisted tree",
  );
  await assert.rejects(
    () => tools.get("ls")!.execute("ls-2", { path: root }, undefined, undefined, ctx),
    /would traverse blacklisted path/,
    "ls blocks a parent directory that would expose a blacklisted child",
  );

  process.stdout.write("ok — privacy tools: read/grep/find/ls reject blacklisted paths\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
