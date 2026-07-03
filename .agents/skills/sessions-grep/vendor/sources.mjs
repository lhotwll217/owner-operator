import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function expandHome(p, home) {
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false, config: null };
  try {
    return { exists: true, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { exists: true, config: null }; // present but unparseable
  }
}

function normalizeEntries(entries, known, home) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const type = entry?.type ?? entry?.source;
    if (!known.has(type) || typeof entry?.root !== 'string' || !entry.root.trim()) return [];
    return [{ type, root: expandHome(entry.root.trim(), home) }];
  });
}

function dedupe(roots) {
  const seen = new Set();
  return roots.filter((r) => {
    const key = `${r.type}\0${r.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Resolve the roots to search. Precedence: --root flags > $SESSION_GREP_SOURCES_FILE
// (a JSON array of { type, root }) > the built-in DEFAULT_SOURCES passed by the caller.
// There is no cwd/project discovery: session transcripts live under $HOME per user, not
// per project, so a bespoke store is either a --root for one call, an edit to the
// built-in defaults (the skill is vendored via `npx skills add`), or the env override.
export function loadSessionSources({
  knownSources,
  defaultSources = [],
  rootOverrides = [],
  env = process.env,
  home = os.homedir(),
} = {}) {
  const known = new Set(knownSources ?? []);

  if (rootOverrides.length) {
    return { origin: 'flags', configPath: null, configError: null, roots: rootOverrides.map((root) => ({ type: 'auto', root })) };
  }

  const defaults = dedupe(normalizeEntries(defaultSources, known, home));
  const configPath = env.SESSION_GREP_SOURCES_FILE || null;
  if (!configPath) return { origin: 'defaults', configPath: null, configError: null, roots: defaults };

  const { exists, config } = readJson(configPath);
  // A broken override must not silently masquerade as "no override": it would hand the
  // user the built-in defaults while they believe their file took effect. Report why.
  if (!exists) return { origin: 'defaults', configPath, configError: 'missing', roots: defaults };
  if (config === null) return { origin: 'defaults', configPath, configError: 'unparseable', roots: defaults };
  if (!Array.isArray(config)) return { origin: 'defaults', configPath, configError: 'not-an-array', roots: defaults };

  return { origin: 'config', configPath, configError: null, roots: dedupe(normalizeEntries(config, known, home)) };
}

export function configuredSourceOf(file, sourceMap, knownSources) {
  const known = new Set(knownSources ?? []);
  const resolvedFile = path.resolve(file);
  let best = null;
  for (const entry of sourceMap.roots) {
    if (entry.type === 'auto' || !known.has(entry.type)) continue;
    const root = path.resolve(entry.root);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolvedFile === root || resolvedFile.startsWith(prefix)) {
      if (!best || root.length > best.root.length) best = { type: entry.type, root };
    }
  }
  return best?.type ?? null;
}
