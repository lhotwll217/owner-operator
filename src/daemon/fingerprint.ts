import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { repoRoot } from "../shared/repo-root";

const ROOTS = ["src", "packages/core"];
const FILES = ["package.json", "package-lock.json", ".pi/settings.json"];

function filesUnder(root: string): string[] {
  const output: string[] = [];
  const walk = (path: string): void => {
    let entries;
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".build") continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) output.push(child);
    }
  };
  walk(root);
  return output;
}

/** Content identity for every runtime input, including uncommitted checkout changes. */
export function runtimeFingerprint(root: string = repoRoot): string {
  const hash = createHash("sha256");
  const paths = [
    ...ROOTS.flatMap((path) => filesUnder(join(root, path))),
    ...FILES.map((path) => join(root, path)).filter((path) => {
      try { return statSync(path).isFile(); } catch { return false; }
    }),
  ].sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  for (const path of paths) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}
