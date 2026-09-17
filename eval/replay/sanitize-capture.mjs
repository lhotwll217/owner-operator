// Remove credential values from a local capture and from the artifacts a replay derived from it.
//
//   node --import tsx eval/replay/sanitize-capture.mjs --capture <dir> [--artifacts <dir>…] [--check]
//
// Live transcripts are never opened. This rewrites the copy in place, replacing each credential
// value with a placeholder of the same length, and then proves the copy is still the same
// artifact: identical byte length, identical line count, every line still parsing as JSON, and
// differences confined to the replaced spans.
//
// `--check` reports what is present without writing, which is how a sanitized capture stays
// verifiable later.
//
// Writes `sanitization.json` under the capture: counts per pattern and per file, and the
// fidelity comparison. Values are never printed, logged, or stored.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join, resolve } from "node:path";
import { mergeCounts, redactCredentials, scanCredentials } from "./credentials.mjs";

const args = process.argv.slice(2);
const flagValues = (name) => args.flatMap((value, index) => (args[index - 1] === `--${name}` ? [value] : []));
const capture = resolve(flagValues("capture")[0] ?? (() => { throw new Error("--capture is required"); })());
const artifactRoots = flagValues("artifacts").map((value) => resolve(value));
const checkOnly = args.includes("--check");

/** Every file a replay reads or a report might quote. Databases are handled column by column. */
function textFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!path.endsWith(".db") && !path.endsWith(".png")) found.push(path);
    }
  };
  walk(root);
  return found;
}

const lineCount = (text) => text.split("\n").length;

/** Characters that differ, and how many contiguous runs they form: one run per replaced value. */
function compare(before, after) {
  let characters = 0;
  let runs = 0;
  let inRun = false;
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) { inRun = false; continue; }
    characters += 1;
    if (!inRun) runs += 1;
    inRun = true;
  }
  return { characters, runs };
}
const jsonLines = (path, text) =>
  path.endsWith(".jsonl") || path.endsWith(".ndjson")
    ? text.split("\n").filter(Boolean).every((line) => { try { JSON.parse(line); return true; } catch { return false; } })
    : true;

const report = {
  ranAt: new Date().toISOString(),
  mode: checkOnly ? "check" : "sanitize",
  capture,
  artifactRoots,
  redacted: {},
  files: [],
  fidelity: { filesRewritten: 0, lengthPreserved: 0, lineCountPreserved: 0, jsonStillParses: 0, changedCharacters: 0, changedRuns: 0 },
  remaining: {},
};

for (const root of [capture, ...artifactRoots]) {
  for (const path of textFiles(root)) {
    const original = readFileSync(path, "utf8");
    const { text, counts } = redactCredentials(original);
    if (!Object.keys(counts).length) continue;
    mergeCounts(report.redacted, counts);
    report.files.push({ file: basename(path), root: root === capture ? "capture" : "artifacts", counts });
    if (checkOnly) continue;
    const { characters, runs } = compare(original, text);
    report.fidelity.filesRewritten += 1;
    report.fidelity.lengthPreserved += text.length === original.length ? 1 : 0;
    report.fidelity.lineCountPreserved += lineCount(text) === lineCount(original) ? 1 : 0;
    report.fidelity.jsonStillParses += jsonLines(path, text) ? 1 : 0;
    report.fidelity.changedCharacters += characters;
    report.fidelity.changedRuns += runs;
    writeFileSync(path, text);
  }
}

// The state database carries transcript-derived text of its own: the row title a scan copied
// from the first message, and every generated title and status summary.
const databasePath = join(capture, "state.db");
if (statSync(databasePath, { throwIfNoEntry: false })) {
  const db = new DatabaseSync(databasePath);
  const columns = [
    ["threads", "raw_topic", "id"],
    ["threads", "owner_title", "id"],
    ["thread_details", "topic", "rowid"],
    ["thread_details", "status_summary", "rowid"],
  ];
  for (const [table, column, key] of columns) {
    const rows = db.prepare(`SELECT ${key} AS key, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
    for (const row of rows) {
      const { text, counts } = redactCredentials(String(row.value));
      if (!Object.keys(counts).length) continue;
      mergeCounts(report.redacted, counts);
      report.files.push({ file: `state.db:${table}.${column}`, root: "capture", counts });
      if (checkOnly) continue;
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(text, row.key);
      const { characters, runs } = compare(String(row.value), text);
      report.fidelity.filesRewritten += 1;
      report.fidelity.lengthPreserved += text.length === String(row.value).length ? 1 : 0;
      report.fidelity.lineCountPreserved += 1;
      report.fidelity.jsonStillParses += 1;
      report.fidelity.changedCharacters += characters;
      report.fidelity.changedRuns += runs;
    }
  }
  db.close();
}

// Read everything back and prove nothing matches any pattern.
for (const root of [capture, ...artifactRoots]) {
  for (const path of textFiles(root)) mergeCounts(report.remaining, scanCredentials(readFileSync(path, "utf8")));
}
if (statSync(databasePath, { throwIfNoEntry: false })) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  for (const [table, column] of [["threads", "raw_topic"], ["threads", "owner_title"], ["thread_details", "topic"], ["thread_details", "status_summary"]]) {
    for (const row of db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all()) {
      mergeCounts(report.remaining, scanCredentials(String(row.value)));
    }
  }
  db.close();
}

// Every pass appends: the sanitizing run stays on the record when a later check re-reads the
// same capture and finds it clean.
const recordPath = join(capture, "sanitization.json");
const previous = statSync(recordPath, { throwIfNoEntry: false })
  ? JSON.parse(readFileSync(recordPath, "utf8")).runs ?? []
  : [];
writeFileSync(recordPath, `${JSON.stringify({ runs: [...previous, report] }, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = !checkOnly && Object.keys(report.remaining).length ? 1 : 0;
