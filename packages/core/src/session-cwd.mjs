// Owner Operator — resolve a session's working directory and repo from its transcript.
// The privacy blacklist keys off {cwd, repo}: which tree a session ran in, and (for a
// git worktree) the REAL repo behind a codename cwd. Both the triage scan and the grep
// wrapper must answer this the same way, or a thread hidden from one surface could leak
// through the other — so the resolution lives here, once. Plain ESM (not TS) so the
// zero-install skills run the exact code the harness uses.
//
// NOTE: get-active-threads.mjs still carries an inline `realRepo` (embedded in its
// parseSession); converging it onto this module is the intended follow-up so there is a
// single cwd/repo authority.

import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The session's working directory, read from the first record that carries one. Claude
 * records and the pi `{type:"session"}` header put it at top-level `cwd`; Codex carries
 * it at `payload.cwd`. Source-agnostic (checks both) so one pass covers every format.
 * Returns null when no record declares a cwd.
 */
export function firstCwd(raw) {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (typeof obj.cwd === "string") return obj.cwd;
    if (obj.payload && typeof obj.payload.cwd === "string") return obj.payload.cwd;
  }
  return null;
}

/**
 * The real repo name for a cwd. Normal checkout → its own folder. A git worktree (e.g. a
 * Conductor workspace) has a `.git` FILE "gitdir: <repo>/.git/worktrees/<name>", so the
 * repo is taken from that path rather than the worktree codename. Best-effort: dir gone or
 * not a worktree → the cwd leaf. Null cwd → null.
 */
export function resolveRepo(cwd) {
  if (!cwd) return null;
  try {
    const dotGit = join(cwd, ".git");
    if (statSync(dotGit).isFile()) {
      const m = /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(readFileSync(dotGit, "utf8"));
      if (m) return basename(m[1].trim());
    }
  } catch { /* dir gone or not a worktree → fall through */ }
  return basename(cwd);
}
