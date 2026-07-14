import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isBlacklisted, loadBlacklist } from "./blacklist.mjs";
import {
  KNOWN_SESSION_SOURCES,
  SESSION_SOURCE_DESCRIPTORS,
  loadSessionSources,
} from "./session-sources.mjs";

const defaultHome = () => process.env.OO_HOME ?? join(homedir(), ".owner-operator");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}

// Bounded filename-only walk. This never opens a transcript.
function countSessions(root, { cap = 500, maxDepth = 6 } = {}) {
  let exists = false;
  let count = 0;
  const walk = (dir, depth) => {
    if (count >= cap || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    exists = true;
    for (const entry of entries) {
      if (count >= cap) return;
      if (entry.isDirectory()) { walk(join(dir, entry.name), depth + 1); continue; }
      if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".ndjson") || entry.name.endsWith(".json")) count++;
    }
  };
  walk(root, 0);
  return { exists, count };
}

/** Probe configured roots for the pre-scan confirmation screen. */
export function detectSources(ooHome = defaultHome(), opts = {}) {
  return loadSessionSources(ooHome).map(({ source, root }) => ({ source, root, ...countSessions(root, opts) }));
}

/** Collapse configured-root probes to one row per source. */
export function summarizeDetectedSources(detected) {
  const by = new Map();
  for (const { source, root, exists, count } of detected) {
    const acc = by.get(source) ?? { source, roots: [], exists: false, count: 0 };
    acc.roots.push(root);
    acc.exists ||= exists;
    acc.count += count;
    by.set(source, acc);
  }
  return [...by.values()];
}

function sourceCandidate(source, root, tier) {
  if (tier !== 3) return { source, root, tier, exists: existsSync(root), shape: false };
  const counted = countSessions(root, { cap: 1, maxDepth: 3 });
  return { source, root, tier, exists: counted.exists, shape: counted.count > 0 };
}

function mountedVolumes() {
  if (process.platform !== "darwin") return [];
  try {
    return readdirSync("/Volumes", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join("/Volumes", entry.name));
  } catch {
    return [];
  }
}

const PRUNED_NAMES = new Set([".git", "node_modules", "Caches", "CloudStorage", "Mobile Documents", "iCloud Drive"]);

/** Detect candidate roots without configuring them. Tier 3 is opt-in and bounded. */
export function detectSessionSourceCandidates(ooHome = defaultHome(), options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const candidates = [];
  const blacklist = loadBlacklist(ooHome);
  const add = (source, root, tier) => {
    if (!KNOWN_SESSION_SOURCES.includes(source) || typeof root !== "string" || !root.trim()) return;
    const value = root.trim();
    const absolute = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : resolve(value);
    if (!isBlacklisted(blacklist, { cwd: absolute, repo: basename(absolute) })) {
      candidates.push(sourceCandidate(source, absolute, tier));
    }
  };

  const configured = readJson(join(ooHome, "session_sources.json"));
  for (const entry of Array.isArray(configured.add) ? configured.add : []) add(entry?.source, entry?.root, 1);
  for (const descriptor of SESSION_SOURCE_DESCRIPTORS) {
    for (const declared of descriptor.declared) {
      const base = env[declared.env];
      if (typeof base === "string" && base.trim()) add(descriptor.source, join(base, ...declared.suffix), 1);
    }
  }

  const piAgentDir = typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim()
    ? resolve(env.PI_CODING_AGENT_DIR)
    : join(home, ".pi", "agent");
  const piSettings = readJson(join(piAgentDir, "settings.json"));
  if (typeof piSettings.sessionDir === "string" && piSettings.sessionDir.trim()) {
    const value = piSettings.sessionDir.trim();
    add("pi", value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : resolve(piAgentDir, value), 1);
  }
  if (typeof env.PI_CODING_AGENT_SESSION_DIR === "string" && env.PI_CODING_AGENT_SESSION_DIR.trim()) {
    add("pi", resolve(env.PI_CODING_AGENT_SESSION_DIR), 1);
  }

  for (const descriptor of SESSION_SOURCE_DESCRIPTORS) {
    for (const parts of [...descriptor.defaults, ...descriptor.common]) add(descriptor.source, join(home, ...parts), 2);
  }

  if (options.deep) {
    const deadline = Date.now() + Math.max(1, options.timeoutMs ?? 2_000);
    const maxDepth = Math.max(1, options.maxDepth ?? 5);
    const roots = [home, ...(options.volumes ?? mountedVolumes())];
    const markers = new Map();
    for (const descriptor of SESSION_SOURCE_DESCRIPTORS) {
      for (const deep of descriptor.deep) {
        const entries = markers.get(deep.marker) ?? [];
        entries.push({ source: descriptor.source, suffix: deep.suffix });
        markers.set(deep.marker, entries);
      }
    }
    const walk = (dir, depth) => {
      if (depth > maxDepth || Date.now() >= deadline) return;
      if (isBlacklisted(blacklist, { cwd: dir, repo: basename(dir) })) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() >= deadline) return;
        if (!entry.isDirectory() || PRUNED_NAMES.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (isBlacklisted(blacklist, { cwd: path, repo: entry.name })) continue;
        for (const match of markers.get(entry.name) ?? []) {
          const candidate = sourceCandidate(match.source, join(path, ...match.suffix), 3);
          if (candidate.shape) candidates.push(candidate);
        }
        walk(path, depth + 1);
      }
    };
    for (const root of roots) walk(root, 0);
  }

  const seen = new Set();
  return candidates
    .sort((a, b) => a.tier - b.tier)
    .filter((candidate) => {
      const key = `${candidate.source}\0${candidate.root}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
