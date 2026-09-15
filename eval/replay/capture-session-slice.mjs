// Capture a frozen slice of real Owner Operator state and its transcripts for local replay.
//
//   node eval/replay/capture-session-slice.mjs --out <dir> [--window 7d] [--oo-home <dir>]
//   node eval/replay/capture-session-slice.mjs --verify <dir>
//
// The live state database is opened read-only and the live transcripts are copied, never
// written. Rows are copied verbatim: bad summaries, missing history, and stale enrichment
// watermarks are the point of the capture, so nothing here repairs or regenerates them.
//
// Every session is authorized by the privacy-aware session-search helper before its bytes are
// copied: the helper applies the configured sources and the owner's blacklist, and the path it
// resolves must be the path this capture reads. The helper answers with bounded views, never a
// whole transcript, and a replay needs the whole file to reproduce the scan — so the helper
// decides access and the copy supplies fidelity. `--verify` re-runs that authorization, and the
// credential scan, against an existing capture without rebuilding it.
//
// Output layout under --out:
//   state.db                     schema-current copy of the selected rows
//   transcripts/<store>/...      transcript files, relative layout preserved per store
//   stores.json                  { store key -> transcript format } for the replay home
//   manifest.json                provenance: counts, span, source mix, coverage, authorization,
//                                and what a credential scan of the copied bytes found
//
// The slice is anchored, not stamped: manifest.anchor is the newest message in the slice, and
// build-replay-home.mjs shifts every timestamp by (run start - anchor) so relative timing —
// and therefore working/idle/needs-you classification — reproduces on every run.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isBlacklisted, loadBlacklist, loadMonitoredTranscriptStores } from "@owner-operator/core";
import { ThreadDb } from "../../src/state/database.ts";

const SEARCH_HELPER = fileURLToPath(new URL("../../src/agent/skills/session-search/scripts/session-search.mjs", import.meta.url));
const INSTALL_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Ask the approved helper whether this session may be read, and which file it resolves to. */
function authorizeSession(id, home) {
  try {
    const header = execFileSync(process.execPath, [SEARCH_HELPER, "--skim", id, "--max-chars", "500"], {
      encoding: "utf8", maxBuffer: 1024 * 1024,
      env: { ...process.env, OO_HOME: home, OO_INSTALL_ROOT: INSTALL_ROOT },
    }).split("\n", 1)[0];
    const path = /\spath=(.+)$/.exec(header)?.[1];
    return path && header.startsWith(`skim id=${id} `)
      ? { authorized: true, path }
      : { authorized: false, reason: "the helper resolved a different session" };
  } catch (error) {
    const message = String(error.stderr || error.message).split("\n", 1)[0];
    return { authorized: false, reason: message.slice(0, 200) };
  }
}

// Credential-shaped material in a capture is reported, never inferred: a transcript holds
// whatever the owner's own work put in it, and a capture is a second copy of that.
const CREDENTIAL_PATTERNS = [
  ["openai or anthropic key", /\b(?:sk-|sk-ant-)[A-Za-z0-9_-]{20,}/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}/g],
  ["slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/g],
  ["private key block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ["json web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer authorization", /\b[Aa]uthorization["'\s:]+Bearer\s+[A-Za-z0-9._-]{20,}/g],
];

/** What credential-shaped strings the copied bytes contain, by pattern and file. Values stay out. */
function scanCredentials(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!path.endsWith(".db")) files.push(path);
    }
  };
  walk(root);
  const findings = {};
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [name, pattern] of CREDENTIAL_PATTERNS) {
      const found = text.match(pattern);
      if (!found) continue;
      const entry = findings[name] ??= { matches: 0, files: [] };
      entry.matches += found.length;
      entry.files.push(basename(file));
    }
  }
  return { filesScanned: files.length, findings };
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const ooHome = resolve(flag("oo-home", process.env.OO_HOME ?? join(homedir(), ".owner-operator")));

// Verification re-asks the same questions of an existing capture: does the approved helper
// still authorize every session in it, does it resolve each one to the file that was copied,
// and what credential-shaped material do those bytes hold?
const verifyDir = flag("verify", "");
if (verifyDir) {
  const captureDir = resolve(verifyDir);
  const manifest = JSON.parse(readFileSync(join(captureDir, "manifest.json"), "utf8"));
  const copied = [];
  const walkCopies = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkCopies(path);
      else if (path.endsWith(".jsonl") || path.endsWith(".ndjson")) copied.push(path);
    }
  };
  walkCopies(join(captureDir, "transcripts"));
  const captureDb = new DatabaseSync(join(captureDir, "state.db"), { readOnly: true });
  const byFile = new Map(captureDb.prepare("SELECT id, transcript_path FROM threads WHERE transcript_path IS NOT NULL")
    .all().map((row) => [basename(row.transcript_path), row.id]));
  captureDb.close();
  const unauthorized = [];
  const mismatched = [];
  let authorized = 0;
  for (const file of copied) {
    const id = byFile.get(basename(file));
    if (!id) { unauthorized.push({ file: basename(file), reason: "no thread row names this file" }); continue; }
    const decision = authorizeSession(id, ooHome);
    if (!decision.authorized) { unauthorized.push({ id, reason: decision.reason }); continue; }
    if (basename(decision.path) !== basename(file)) {
      mismatched.push({ id, helper: basename(decision.path), captured: basename(file) });
      continue;
    }
    authorized += 1;
  }
  const verification = {
    verifiedAt: new Date().toISOString(),
    capture: captureDir,
    capturedAt: manifest.capturedAt,
    transcripts: copied.length,
    authorizedBySearchHelper: authorized,
    unauthorized,
    resolvedToADifferentFile: mismatched,
    credentialScan: scanCredentials(captureDir),
  };
  writeFileSync(join(captureDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
  process.exit(unauthorized.length || mismatched.length ? 1 : 0);
}

const out = resolve(flag("out", "") || (() => { throw new Error("--out is required"); })());
const window = flag("window", "7d");
const windowDays = /^(\d+)d$/.exec(window)?.[1];
if (!windowDays) throw new Error(`--window must look like 7d, received ${window}`);

const live = new DatabaseSync(join(ooHome, "state.db"), { readOnly: true });
const all = (sql, ...params) => live.prepare(sql).all(...params);

// ---- select the slice ---------------------------------------------------------------
// Recent activity picks the window; delegation then pulls in every counterpart of a selected
// thread so parent/child relationships stay whole rather than half-captured at the edge.
const cutoff = new Date(Date.now() - Number(windowDays) * 86_400_000).toISOString();
const selected = new Set(all(
  "SELECT id FROM threads WHERE last_message_at > ?", cutoff,
).map((row) => row.id));
for (let added = true; added; ) {
  added = false;
  const ids = [...selected];
  const placeholders = ids.map(() => "?").join(",");
  const related = all(
    `SELECT parent_thread_id AS parent, child_session_id AS child FROM agent_runs
     WHERE parent_thread_id IN (${placeholders}) OR child_session_id IN (${placeholders})`,
    ...ids, ...ids,
  );
  for (const { parent, child } of related) {
    for (const id of [parent, child]) {
      if (!id || selected.has(id)) continue;
      if (!all("SELECT 1 FROM threads WHERE id = ?", id).length) continue;
      selected.add(id);
      added = true;
    }
  }
}

// Defense in depth: the live database is already purged of blacklisted work, so this should
// never fire — it exists so a configuration change cannot silently widen a capture.
const blacklist = loadBlacklist(ooHome);
const threads = all("SELECT * FROM threads").filter((row) => selected.has(row.id));
const excluded = threads.filter((row) => isBlacklisted(blacklist, { cwd: row.project, repo: row.repo }));
for (const row of excluded) selected.delete(row.id);
const kept = threads.filter((row) => selected.has(row.id));

// ---- copy transcripts ---------------------------------------------------------------
// Each file lands under a per-store directory so the replay home can point one configured
// root at it and the scan resolves the same transcript format it resolved in production.
const stores = loadMonitoredTranscriptStores(ooHome)
  .map((store) => ({ ...store, root: resolve(store.root) }))
  .sort((a, b) => b.root.length - a.root.length);
const storeKey = (store) => `${store.format}-${store.root.split(sep).filter(Boolean).slice(-2).join("-")}`;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "transcripts"), { recursive: true });

const usedStores = new Map();
const copied = [];
const unavailable = [];
const unauthorized = [];
for (const row of kept) {
  const path = row.transcript_path ? resolve(row.transcript_path) : null;
  const store = path && stores.find((candidate) => path.startsWith(candidate.root + sep));
  if (!path || !store) { unavailable.push({ id: row.id, reason: path ? "outside-configured-store" : "no-transcript-path" }); continue; }
  // The helper decides access; a session it refuses, or resolves elsewhere, is left behind.
  const decision = authorizeSession(row.id, ooHome);
  if (!decision.authorized || resolve(decision.path) !== path) {
    unauthorized.push({ id: row.id, reason: decision.reason ?? "the helper resolved a different file" });
    selected.delete(row.id);
    continue;
  }
  const key = storeKey(store);
  usedStores.set(key, store.format);
  const destination = join(out, "transcripts", key, relative(store.root, path));
  try {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
    copied.push({ id: row.id, source: row.source, bytes: readFileSync(destination).length });
  } catch (error) {
    unavailable.push({ id: row.id, reason: `unreadable: ${error.message}` });
  }
}

// ---- copy rows verbatim -------------------------------------------------------------
const fixture = new ThreadDb(join(out, "state.db"));
fixture.close();
const target = new DatabaseSync(join(out, "state.db"));
target.exec("PRAGMA foreign_keys = OFF");

const insert = (table, rows) => {
  if (!rows.length) return 0;
  const columns = target.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  const statement = target.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column] ?? null));
  return rows.length;
};

const authorizedRows = kept.filter((row) => selected.has(row.id));
const ids = [...selected];
const placeholders = ids.map(() => "?").join(",");
const details = all(`SELECT * FROM thread_details WHERE thread_id IN (${placeholders})`, ...ids);
const runs = all(
  `SELECT * FROM agent_runs WHERE parent_thread_id IN (${placeholders}) OR child_session_id IN (${placeholders})`,
  ...ids, ...ids,
);
const selections = all(`SELECT * FROM thread_worktrees WHERE thread_id IN (${placeholders})`, ...ids);
const worktreeIds = new Set(selections.map((row) => row.worktree_id));
const worktrees = all("SELECT * FROM worktrees").filter((row) => worktreeIds.has(row.id));

target.exec("BEGIN IMMEDIATE");
insert("threads", authorizedRows);
insert("thread_details", details);
insert("worktrees", worktrees);
insert("thread_worktrees", selections);
insert("agent_runs", runs);
insert("schedules", all("SELECT * FROM schedules"));
insert("schedule_runs", all("SELECT * FROM schedule_runs"));
insert("schedule_event_watermarks", all(`SELECT * FROM schedule_event_watermarks WHERE thread_id IN (${placeholders})`, ...ids));
target.exec("COMMIT");

// A run whose counterpart thread was never observed would violate the copied foreign keys;
// report it rather than repair it, so the capture stays a faithful record.
const violations = target.prepare("PRAGMA foreign_key_check").all();
target.close();
live.close();

// ---- manifest -----------------------------------------------------------------------
const current = new Map();
for (const row of details) {
  const latest = current.get(row.thread_id);
  if (!latest || row.version > latest.version) current.set(row.thread_id, row);
}
const tally = (rows, pick) => rows.reduce((counts, row) => {
  const key = String(pick(row) ?? "(none)");
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const times = authorizedRows.map((row) => row.last_message_at).filter(Boolean).sort();
const anchor = times.at(-1);

const manifest = {
  capturedAt: new Date().toISOString(),
  ooHome,
  window,
  anchor,
  earliestMessageAt: times[0],
  threads: authorizedRows.length,
  detailVersions: details.length,
  maxDetailVersion: Math.max(0, ...details.map((row) => row.version)),
  transcriptsCopied: copied.length,
  transcriptBytes: copied.reduce((sum, file) => sum + file.bytes, 0),
  bySource: tally(authorizedRows, (row) => row.source),
  byApp: tally(authorizedRows, (row) => row.app),
  byState: tally([...current.values()], (row) => row.state),
  byRepo: tally(authorizedRows, (row) => row.repo),
  coverage: {
    ownerTitles: authorizedRows.filter((row) => row.owner_title).length,
    neverEnriched: authorizedRows.filter((row) => !row.enriched_through_message_at).length,
    staleEnrichment: authorizedRows.filter((row) => row.enriched_through_message_at && row.enriched_through_message_at < row.last_message_at).length,
    freshEnrichment: authorizedRows.filter((row) => row.enriched_through_message_at === row.last_message_at).length,
    latestWithSummary: [...current.values()].filter((row) => row.summary).length,
    latestWithTopic: [...current.values()].filter((row) => row.topic).length,
    revisedThreads: [...current.values()].filter((row) => row.version > 1).length,
    delegatingParents: new Set(runs.map((row) => row.parent_thread_id).filter(Boolean)).size,
    delegatedChildren: new Set(runs.map((row) => row.child_session_id).filter(Boolean)).size,
    runsByStatus: tally(runs, (row) => row.status),
    worktrees: worktrees.length,
  },
  unavailableHistory: unavailable,
  authorizedBySearchHelper: copied.length,
  unauthorizedBySearchHelper: unauthorized,
  credentialScan: scanCredentials(out),
  blacklistedThreadsExcluded: excluded.length,
  foreignKeyViolations: violations.length,
  stores: Object.fromEntries(usedStores),
};

writeFileSync(join(out, "stores.json"), `${JSON.stringify(Object.fromEntries(usedStores), null, 2)}\n`);
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
