// Owner Operator — session hosts. A host is the owner-facing CLI or app around an agent
// harness. Hosts attribute sessions and decide whether a non-interactive transport is still an
// owner-opened session; they do not grant transcript access. Plain ESM keeps the scanner and
// zero-install skill on the same implementation. Types: session-hosts.d.mts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { AGENT_HARNESS_DESCRIPTORS } from "./session-sources.mjs";

const allHarnesses = Object.freeze([
  "claude-code",
  "codex",
  "cursor-agent",
  "posthog-code",
  "pi",
  "opencode",
  "antigravity",
  "grok-build",
]);
const cliHarnesses = Object.freeze(allHarnesses.filter((id) => id !== "posthog-code"));

/**
 * Stable host identities. `review` controls the onboarding inventory; SDK transports remain
 * internal because owners choose an app or CLI, not a transport. Root hosts win before metadata
 * hosts, so a Codex transcript in a Superset worktree is attributed to Superset.
 */
export const SESSION_HOST_DESCRIPTORS = Object.freeze([
  {
    id: "superset",
    label: "Superset App",
    review: true,
    harnesses: cliHarnesses,
    defaultRoots: [[".superset", "worktrees"]],
    appNames: ["Superset.app"],
    overridesAutomation: true,
  },
  {
    id: "conductor",
    label: "Conductor",
    review: true,
    harnesses: ["claude-code", "codex", "cursor-agent", "opencode"],
    defaultRoots: [["conductor", "workspaces"]],
    appNames: ["Conductor.app"],
    overridesAutomation: true,
  },
  {
    id: "posthog-code",
    label: "PostHog Code",
    review: true,
    harnesses: ["posthog-code"],
    formats: ["posthog-code"],
    formatMatch: true,
    appNames: ["PostHog Code.app"],
    surfaceEmpty: true,
    overridesAutomation: true,
  },
  {
    id: "claude-app",
    label: "Claude App",
    review: true,
    harnesses: ["claude-code"],
    formats: ["claude"],
    entrypoints: ["claude-desktop", "claude-app", "desktop"],
    appNames: ["Claude.app"],
  },
  {
    id: "claude-sdk",
    label: "Claude SDK",
    review: false,
    harnesses: ["claude-code"],
    formats: ["claude"],
    entrypoints: ["sdk-ts", "sdk-python", "sdk-cli"],
    automatedTransport: true,
  },
  {
    id: "claude-cli",
    label: "Claude CLI",
    review: true,
    harnesses: ["claude-code"],
    formats: ["claude"],
    commands: ["claude"],
    fallback: true,
  },
  {
    id: "codex-app",
    label: "Codex App",
    review: true,
    harnesses: ["codex"],
    formats: ["codex"],
    sourceHints: ["vscode", "codex-app", "desktop"],
    appNames: ["Codex.app"],
  },
  {
    id: "codex-sdk",
    label: "Codex SDK",
    review: false,
    harnesses: ["codex"],
    formats: ["codex"],
    originators: ["codex_sdk_ts", "codex-sdk"],
    automatedTransport: true,
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    review: true,
    harnesses: ["codex"],
    formats: ["codex"],
    originators: ["codex_cli_rs"],
    commands: ["codex"],
    fallback: true,
  },
  { id: "cursor", label: "Cursor", review: true, harnesses: ["cursor-agent"], formats: ["cursor"], appNames: ["Cursor.app"], commands: ["cursor-agent"], fallback: true },
  { id: "pi", label: "Pi", review: true, harnesses: ["pi"], formats: ["pi"], commands: ["pi"], fallback: true },
  { id: "opencode", label: "OpenCode", review: true, harnesses: ["opencode"], formats: ["opencode"], commands: ["opencode"], fallback: true },
  { id: "antigravity", label: "Antigravity", review: true, harnesses: ["antigravity"], formats: ["antigravity"], fallback: true },
  { id: "grok-build", label: "Grok Build", review: true, harnesses: ["grok-build"], formats: ["grok-build"], fallback: true },
]);

export const KNOWN_SESSION_HOSTS = Object.freeze(SESSION_HOST_DESCRIPTORS.map(({ id }) => id));
export const REVIEWED_SESSION_HOSTS = Object.freeze(SESSION_HOST_DESCRIPTORS.filter(({ review }) => review).map(({ id }) => id));

const expand = (path, home) => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

function normalizedAbsolute(path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const normalized = normalize(isAbsolute(path) ? path : resolve(path));
  return normalized.endsWith(sep) && normalized !== sep ? normalized.slice(0, -1) : normalized;
}

function containsPath(root, candidate) {
  const normalizedRoot = normalizedAbsolute(root);
  const normalizedCandidate = normalizedAbsolute(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

const hostOwnsCwd = (host, cwd) =>
  (host.roots ?? []).some((root) => containsPath(root, cwd)) ||
  (host.cwdMarkers ?? []).some((marker) => cwd.includes(marker));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}

/** Built-in hosts plus configured roots and legacy gui_hosts.json additions. Never throws. */
export function loadSessionHosts(
  ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator"),
  options = {},
) {
  const home = options.home ?? homedir();
  const rootsByHost = new Map();
  for (const descriptor of SESSION_HOST_DESCRIPTORS) {
    rootsByHost.set(descriptor.id, (descriptor.defaultRoots ?? []).map((parts) => join(home, ...parts)));
  }

  const config = readJson(join(ooHome, "session_hosts.json"));
  for (const entry of Array.isArray(config.roots) ? config.roots : []) {
    if (!KNOWN_SESSION_HOSTS.includes(entry?.host) || typeof entry?.root !== "string" || !entry.root.trim()) continue;
    rootsByHost.get(entry.host).push(expand(entry.root.trim(), home));
  }

  const hosts = SESSION_HOST_DESCRIPTORS.map((descriptor) => ({
    ...descriptor,
    roots: [...new Set(rootsByHost.get(descriptor.id) ?? [])],
  }));

  for (const entry of Array.isArray(config.add) ? config.add : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const roots = (Array.isArray(entry?.roots) ? entry.roots : []).filter((root) => typeof root === "string" && root.trim()).map((root) => expand(root.trim(), home));
    const formats = (Array.isArray(entry?.formats) ? entry.formats : []).filter((format) => typeof format === "string" && format.trim());
    if (!id || KNOWN_SESSION_HOSTS.includes(id) || !label || (!roots.length && !formats.length)) continue;
    hosts.push({ id, label, review: true, harnesses: [], roots, formats, formatMatch: formats.length > 0, overridesAutomation: Boolean(entry.overridesAutomation), surfaceEmpty: Boolean(entry.surfaceEmpty) });
  }

  // gui_hosts.json predates stable host IDs. Preserve it as a compatibility input while all new
  // writes use session_hosts.json. A marker becomes an absolute rooted host when possible.
  const legacy = readJson(join(ooHome, "gui_hosts.json"));
  for (const [index, entry] of (Array.isArray(legacy.add) ? legacy.add : []).entries()) {
    const label = typeof entry?.ui === "string" ? entry.ui.trim() : "";
    const marker = typeof entry?.cwdMarker === "string" ? entry.cwdMarker.trim() : "";
    const format = typeof entry?.source === "string" ? entry.source.trim() : "";
    if (!label || (!marker && !format)) continue;
    hosts.push({
      id: `legacy-${index}`,
      label,
      review: false,
      harnesses: [],
      ...(marker ? { cwdMarkers: [marker] } : {}),
      ...(format ? { formats: [format] } : {}),
      formatMatch: Boolean(format),
      overridesAutomation: true,
      surfaceEmpty: Boolean(entry.surfaceEmpty),
      roots: [],
    });
  }
  return hosts;
}

/** The rooted session host that owns a cwd, or null. Root containment is path-boundary safe. */
export function sessionHostForCwd(cwd, hosts = loadSessionHosts()) {
  if (!cwd) return null;
  return hosts.find((host) => hostOwnsCwd(host, cwd)) ?? null;
}

/** Resolve owner-facing host identity. Rooted hosts win; exact metadata wins over fallback CLI. */
export function sessionHostFor(session, hosts = loadSessionHosts()) {
  const harness = AGENT_HARNESS_DESCRIPTORS.find(({ transcriptFormat }) => transcriptFormat === session?.format)?.id;
  const rooted = session?.cwd
    ? hosts.find((host) => hostOwnsCwd(host, session.cwd) && (!harness || host.harnesses.length === 0 || host.harnesses.includes(harness)))
    : null;
  if (rooted) return rooted;

  const candidates = hosts.filter((host) => (host.formats ?? []).includes(session?.format));
  const exact = candidates.find((host) =>
    host.formatMatch ||
    (host.entrypoints ?? []).includes(session?.entrypoint) ||
    (host.originators ?? []).includes(session?.originator) ||
    (host.sourceHints ?? []).includes(session?.sourceHint),
  );
  return exact ?? candidates.find((host) => host.fallback) ?? candidates[0] ?? null;
}
