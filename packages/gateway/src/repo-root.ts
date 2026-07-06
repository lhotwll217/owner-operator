// Repo-root resolution for the gateway package. The gateway may locate repo-owned assets
// such as scan skills and the dev launcher, but it must not import harness code.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // packages/gateway/src
export const repoRoot = join(here, "..", "..", "..");
