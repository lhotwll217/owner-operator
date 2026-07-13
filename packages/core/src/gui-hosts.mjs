// Compatibility adapter for the pre-v3 GUI-host API. The canonical host registry now lives in
// session-hosts.mjs; this view exposes only hosts that override worker classification.

import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import { loadSessionHosts } from "./session-hosts.mjs";

export function loadGuiHosts(ooHome = process.env.OO_HOME ?? join(homedir(), ".owner-operator")) {
  return loadSessionHosts(ooHome)
    .filter((host) => host.overridesAutomation)
    .map((host) => ({
      ui: host.label,
      ...(host.roots?.length ? { roots: host.roots } : {}),
      ...(host.cwdMarkers?.length ? { cwdMarkers: host.cwdMarkers, cwdMarker: host.cwdMarkers[0] } : {}),
      ...(host.formats?.length ? { source: host.formats[0] } : {}),
      ...(host.surfaceEmpty ? { surfaceEmpty: true } : {}),
    }));
}

const containsPath = (root, cwd) => {
  const value = normalize(root);
  const normalizedRoot = value !== sep && value.endsWith(sep) ? value.slice(0, -1) : value;
  const normalizedCwd = normalize(cwd);
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}${sep}`);
};

export function guiHostForCwd(cwd, hosts = loadGuiHosts()) {
  if (!cwd) return null;
  return hosts.find((host) =>
    (host.roots ?? []).some((root) => containsPath(root, cwd)) ||
    (host.cwdMarkers ?? (host.cwdMarker ? [host.cwdMarker] : [])).some((marker) => cwd.includes(marker)),
  ) ?? null;
}

export function interactiveHost(cwd, source, hosts = loadGuiHosts()) {
  return guiHostForCwd(cwd, hosts) ?? hosts.find((host) => host.source === source) ?? null;
}
