import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";

/** Bundled skills join Pi's normal user/project skill catalog through one shared loader seam. */
export function ownerOperatorResourceLoaderOptions(): { additionalSkillPaths: string[] } {
  return { additionalSkillPaths: [join(repoRoot, "src", "agent", "skills")] };
}
