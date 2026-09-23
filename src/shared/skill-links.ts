/** Links the outside-agent skill (`skills/owner-operator` in this checkout) into agent harnesses
 * the way `npx skills add` lays them out: one canonical entry in the shared Agent Skills root that
 * points into the checkout, and an entry in each harness's skills folder pointing at the canonical
 * one (vercel-labs/skills src/installer.ts createSymlink,
 * https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/installer.ts#L227-L293).
 * Every harness folder that exists is linked; `git pull` updates the skill through the links.
 * Each link this installer created is recorded with the exact target it wrote; a link is only
 * replaced or removed while it still points there, so a link the owner changed is never touched. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ownerOperatorHome } from "./paths";
import { repoRoot } from "./repo-root";

export const SKILL_NAME = "owner-operator";

export interface SkillLinkOptions {
  userHome?: string;
  ooHome?: string;
  checkoutRoot?: string;
  now?: () => Date;
}

export interface SkillLinkTarget {
  /** `agents` is the canonical shared root; the rest are harness folders. */
  label: "agents" | "claude" | "codex" | "cursor";
  folder: string;
  path: string;
  /** What the link must point at. */
  target: string;
}

export type SkillLinkState = "linked" | "dangling" | "other-link" | "copy" | "absent" | "no-folder";

export interface SkillLinkStatus extends SkillLinkTarget {
  state: SkillLinkState;
  /** The link's own target, when it is a link. */
  linkTarget: string | null;
  /** Where it finally resolves, or null when it does not. */
  resolvesTo: string | null;
}

export interface SkillLinkChange extends SkillLinkTarget {
  action: "linked" | "already-linked" | "replaced-copy" | "skipped" | "removed";
  detail?: string;
}

function locations(options: SkillLinkOptions) {
  const home = options.userHome ?? homedir();
  const source = join(options.checkoutRoot ?? repoRoot, "skills", SKILL_NAME);
  const canonicalFolder = join(home, ".agents", "skills");
  const canonical = join(canonicalFolder, SKILL_NAME);
  const harness = (label: SkillLinkTarget["label"], folder: string): SkillLinkTarget =>
    ({ label, folder, path: join(folder, SKILL_NAME), target: canonical });
  return {
    source,
    manifest: join(options.ooHome ?? ownerOperatorHome(), "skill-links.json"),
    backups: join(options.ooHome ?? ownerOperatorHome(), "skill-backups"),
    targets: [
      { label: "agents" as const, folder: canonicalFolder, path: canonical, target: source },
      // Harness homes honor the same overrides `npx skills` does (src/agents.ts#L10-L11 at the SHA above).
      harness("claude", join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), "skills")),
      harness("codex", join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "skills")),
      harness("cursor", join(home, ".cursor", "skills")),
    ],
  };
}

const lstatOrNull = (path: string) => { try { return lstatSync(path); } catch { return null; } };
const realOrNull = (path: string) => { try { return realpathSync(path); } catch { return null; } };

/** Link path → the exact target this installer wrote there. */
type OwnedLinks = Map<string, string>;

function readManifest(path: string): OwnedLinks {
  try {
    const links = (JSON.parse(readFileSync(path, "utf8")) as { links?: unknown }).links;
    return new Map(Array.isArray(links)
      ? links.flatMap((link) => typeof link?.path === "string" && typeof link?.target === "string" ? [[link.path, link.target] as const] : [])
      : []);
  } catch {
    return new Map();
  }
}

function writeManifest(path: string, links: OwnedLinks): void {
  mkdirSync(dirname(path), { recursive: true });
  const entries = [...links].sort(([a], [b]) => a.localeCompare(b)).map(([link, target]) => ({ path: link, target }));
  writeFileSync(path, `${JSON.stringify({ links: entries }, null, 2)}\n`);
}

/** True only while the link still points exactly where this installer pointed it. */
const stillOwned = (owned: OwnedLinks, path: string, linkTarget: string | null): boolean =>
  linkTarget !== null && owned.get(path) === linkTarget;

/** A real directory holding a skill that declares this skill's name: a copied install. */
function isSkillCopy(path: string): boolean {
  try {
    return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "m").test(readFileSync(join(path, "SKILL.md"), "utf8"));
  } catch {
    return false;
  }
}

function statusOf(target: SkillLinkTarget): SkillLinkStatus {
  if (!existsSync(target.folder) && !lstatOrNull(target.folder)) {
    return { ...target, state: target.label === "agents" ? "absent" : "no-folder", linkTarget: null, resolvesTo: null };
  }
  const stat = lstatOrNull(target.path);
  if (!stat) return { ...target, state: "absent", linkTarget: null, resolvesTo: null };
  if (!stat.isSymbolicLink()) return { ...target, state: "copy", linkTarget: null, resolvesTo: realOrNull(target.path) };
  const linkTarget = readlinkSync(target.path);
  const resolvesTo = realOrNull(target.path);
  if (resolve(dirname(target.path), linkTarget) !== resolve(target.target)) {
    return { ...target, state: resolvesTo ? "other-link" : "dangling", linkTarget, resolvesTo };
  }
  return { ...target, state: resolvesTo ? "linked" : "dangling", linkTarget, resolvesTo };
}

export function skillLinkStatus(options: SkillLinkOptions = {}): SkillLinkStatus[] {
  return locations(options).targets.map(statusOf);
}

export function installSkillLinks(options: SkillLinkOptions = {}): SkillLinkChange[] {
  const { source, manifest, backups, targets } = locations(options);
  if (!existsSync(join(source, "SKILL.md"))) throw new Error(`no skill at ${source}`);
  const owned = readManifest(manifest);
  const stamp = (options.now?.() ?? new Date()).toISOString().replaceAll(":", "-");
  const changes: SkillLinkChange[] = [];
  for (const target of targets) {
    const status = statusOf(target);
    // Harness links point at the canonical entry, so they are only made while it is this checkout's.
    if (target.label !== "agents" && realOrNull(target.target) !== realOrNull(source)) {
      changes.push({ ...target, action: "skipped", detail: `${target.target} does not resolve to ${source}; not linking to it` });
      continue;
    }
    if (status.state === "no-folder") {
      changes.push({ ...target, action: "skipped", detail: `${target.folder} does not exist` });
      continue;
    }
    if (status.state === "linked") {
      changes.push({ ...target, action: "already-linked" });
      continue;
    }
    let detail: string | undefined;
    if (status.state === "copy") {
      if (!isSkillCopy(target.path)) {
        changes.push({ ...target, action: "skipped", detail: `${target.path} is not an ${SKILL_NAME} skill; left untouched` });
        continue;
      }
      // Move the stale copy aside, outside every skills folder, so no harness loads it twice.
      const backup = join(backups, stamp, target.label);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(target.path, backup);
      detail = `previous copy moved to ${backup}`;
    } else if (status.state === "dangling" || status.state === "other-link") {
      if (!stillOwned(owned, target.path, status.linkTarget)) {
        changes.push({ ...target, action: "skipped", detail: `${target.path} links to ${status.linkTarget}, not a link oo made; left untouched` });
        continue;
      }
      unlinkSync(target.path);
    }
    mkdirSync(target.folder, { recursive: true });
    symlinkSync(target.target, target.path);
    owned.set(target.path, target.target);
    changes.push({ ...target, action: status.state === "copy" ? "replaced-copy" : "linked", ...(detail ? { detail } : {}) });
  }
  writeManifest(manifest, owned);
  return changes;
}

export function uninstallSkillLinks(options: SkillLinkOptions = {}): SkillLinkChange[] {
  const { manifest, targets } = locations(options);
  const owned = readManifest(manifest);
  const changes = targets.map((target): SkillLinkChange => {
    const stat = lstatOrNull(target.path);
    if (!owned.has(target.path)) {
      return { ...target, action: "skipped", detail: stat ? "not a link oo made; left untouched" : "absent" };
    }
    const linkTarget = stat?.isSymbolicLink() ? readlinkSync(target.path) : null;
    if (!stillOwned(owned, target.path, linkTarget)) {
      return { ...target, action: "skipped", detail: stat ? "changed since oo linked it; left untouched" : "already gone" };
    }
    unlinkSync(target.path);
    return { ...target, action: "removed" };
  });
  // Every recorded link is now removed or no longer oo's: either way nothing remains owned.
  writeManifest(manifest, new Map());
  return changes;
}
