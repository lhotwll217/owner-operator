// Repo-root resolution for the gateway. The gateway may locate repo-owned assets
// such as scan skills and the dev launcher, but it must not import agent/CLI code.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // src/gateway
export const repoRoot = join(here, "..", "..");
