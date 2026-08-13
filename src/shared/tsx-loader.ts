import { createRequire } from "node:module";

/** Resolve the repository-owned tsx loader before a child changes to a neutral cwd. */
export function absoluteTsxLoaderPath(): string {
  return createRequire(import.meta.url).resolve("tsx");
}
