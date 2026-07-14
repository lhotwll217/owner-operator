// Hand-written declarations for blacklist.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with blacklist.mjs.

/** The parsed blacklist: directory trees and repo names the owner declared off-limits. */
export interface Blacklist {
  paths: string[];
  repos: string[];
}

/** Load <ooHome>/blacklist.json. Missing or invalid → an empty (block-nothing) list. */
export function loadBlacklist(ooHome: string): Blacklist;

/** Lexical and filesystem-resolved identities for one privacy path. */
export function pathIdentities(path: string): string[];

/** Is a session off-limits? cwd inside any `paths` tree, or repo name in `repos`. */
export function isBlacklisted(
  bl: Blacklist | null | undefined,
  subject: { cwd?: string | null; repo?: string | null },
): boolean;

/** Claude-style project-dir slugs of `paths` — for filename-level skips and SQL LIKEs. */
export function pathSlugs(bl: Blacklist): string[];
