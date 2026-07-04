// Repo-root resolution, shared by the gateway (locating the scan skills) and the agent
// (cwd, settings, skill paths). Lives here so the gateway never imports the agent (#14).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // harness/src/shared
export const repoRoot = join(here, "..", "..", "..");
