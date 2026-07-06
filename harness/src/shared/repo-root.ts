// Repo-root resolution for the pi harness (cwd, settings, prompts, and skill paths).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // harness/src/shared
export const repoRoot = join(here, "..", "..", "..");
