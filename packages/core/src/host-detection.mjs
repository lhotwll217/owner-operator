import { constants, accessSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { loadSessionHosts } from "./session-hosts.mjs";

const expand = (value, home) => value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;

async function sqliteRoots(databasePaths) {
  if (!databasePaths.some(existsSync)) return [];
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return []; }
  const roots = [];
  for (const databasePath of databasePaths.filter(existsSync)) {
    let database;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      for (const table of ["settings", "host_settings", "projects"]) {
        try {
          for (const row of database.prepare(
            `SELECT worktree_base_dir AS root FROM ${table} WHERE worktree_base_dir IS NOT NULL AND trim(worktree_base_dir) != ''`,
          ).all()) {
            if (typeof row.root === "string" && row.root.trim()) roots.push(row.root.trim());
          }
        } catch { /* schema generation does not contain this table */ }
      }
    } catch { /* corrupt, locked, or unsupported database → keep other candidates */ }
    finally { try { database?.close(); } catch { /* already closed */ } }
  }
  return roots;
}

function supersetDatabases(supersetHome) {
  const paths = [join(supersetHome, "local.db")];
  try {
    for (const entry of readdirSync(join(supersetHome, "host"), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(supersetHome, "host", entry.name, "host.db"));
    }
  } catch { /* current host directory absent */ }
  return paths;
}

function commandPath(command, env) {
  for (const directory of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(directory, command);
    try { accessSync(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  return null;
}

/**
 * Detect host evidence without configuring it or opening transcripts. Superset roots come from
 * its settings databases because both global and per-project worktree homes are configurable.
 */
export async function detectSessionHostCandidates(ooHome, options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const candidates = [];
  const applications = options.applications ?? ["/Applications", join(home, "Applications")];
  for (const host of loadSessionHosts(ooHome, { home })) {
    for (const root of host.roots ?? []) candidates.push({ host: host.id, root, exists: existsSync(root), origin: "catalog" });
    for (const appName of host.appNames ?? []) {
      for (const directory of applications) {
        const path = join(directory, appName);
        if (existsSync(path)) candidates.push({ host: host.id, path, exists: true, origin: "app" });
      }
    }
    for (const command of host.commands ?? []) {
      const path = commandPath(command, env);
      if (path) candidates.push({ host: host.id, path, exists: true, origin: "command" });
    }
  }

  const supersetHomeRaw = typeof env.SUPERSET_HOME_DIR === "string" && env.SUPERSET_HOME_DIR.trim()
    ? env.SUPERSET_HOME_DIR.trim()
    : join(home, ".superset");
  const supersetHome = resolve(expand(supersetHomeRaw, home));
  candidates.push({ host: "superset", root: join(supersetHome, "worktrees"), exists: existsSync(join(supersetHome, "worktrees")), origin: "superset-home" });
  for (const value of await sqliteRoots(supersetDatabases(supersetHome))) {
    const root = isAbsolute(value) ? value : resolve(supersetHome, value);
    candidates.push({ host: "superset", root, exists: existsSync(root), origin: "superset-settings" });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.host}\0${candidate.root ?? candidate.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
