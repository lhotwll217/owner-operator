import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const scriptsDirectory = import.meta.dir;
const commanderPackagePath = join(scriptsDirectory, "node_modules", "commander", "package.json");

export function ensureDependenciesInstalled(): void {
  if (existsSync(commanderPackagePath) &&
      JSON.parse(readFileSync(commanderPackagePath, "utf8")).version === "14.0.0") {
    return;
  }
  throw new Error(
    "pstack helper dependencies are absent or stale. Explicit setup required: run bun install --frozen-lockfile in the scripts directory, then retry. No packages were installed."
  );
}
