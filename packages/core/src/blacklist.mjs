// Owner Operator — the privacy blacklist. Repos/paths the owner declared OFF-LIMITS:
// never scanned, never stored, never shown — no flag bypasses it. Lives at
// <ooHome>/blacklist.json:
//
//   { "paths": ["/Users/you/Documents/Personal"], "repos": ["Personal"] }
//
// `paths` block a directory TREE — the repo and every lower-level repo nested beneath it.
// `repos` block by resolved repo name (case-insensitive) — the safety net for worktrees of
// a blacklisted repo that live elsewhere (Superset/Conductor checkouts resolve to the real
// repo name). Enforced at the scan, store, purge, and agent file-tool boundaries. Plain ESM
// (not TS) so the zero-install scan skill runs the exact code the gateway uses (re-exported via
// @owner-operator/core). Types: blacklist.d.mts.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Load <ooHome>/blacklist.json. Missing or invalid → an empty (block-nothing) list. */
export function loadBlacklist(ooHome) {
  try {
    const raw = JSON.parse(readFileSync(join(ooHome, "blacklist.json"), "utf8"));
    const strings = (v) => (Array.isArray(v) ? v : []).filter((s) => typeof s === "string" && s.trim());
    return {
      paths: strings(raw?.paths).map((p) => p.replace(/\/+$/, "")),
      repos: strings(raw?.repos),
    };
  } catch {
    return { paths: [], repos: [] };
  }
}

const fold = (s) => String(s ?? "").toLowerCase();

/** Lexical and filesystem-resolved identities for one privacy path. */
export function pathIdentities(path) {
  let ancestor = path;
  for (;;) {
    try {
      const canonical = resolve(realpathSync.native(ancestor), relative(ancestor, path));
      return canonical === path ? [path] : [path, canonical];
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return [path];
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return [path];
    ancestor = parent;
  }
}

/**
 * Is a session off-limits? True when its cwd sits inside any blacklisted tree, or its
 * resolved repo name matches. Case-insensitive throughout — macOS's default filesystem
 * is, and a casing mismatch must over-block, never leak.
 */
export function isBlacklisted(bl, { cwd, repo } = {}) {
  if (!bl || (!bl.paths.length && !bl.repos.length)) return false;
  if (repo && bl.repos.some((r) => fold(r) === fold(repo))) return true;
  if (cwd) {
    const c = fold(cwd);
    if (bl.paths.some((p) => c === fold(p) || c.startsWith(fold(p) + "/"))) return true;
  }
  return false;
}

/**
 * Claude-style project-dir slugs for the blacklisted paths ("/a/b.c" → "-a-b-c") — for
 * skipping transcript FILES by their directory name, before a single byte is read.
 * A slug matches a dir named exactly `slug` or starting `slug-` (deeper cwd), never a
 * sibling like ...-PersonalSite.
 */
export function pathSlugs(bl) {
  return bl.paths.map((p) => p.replace(/[^A-Za-z0-9-]/g, "-"));
}
