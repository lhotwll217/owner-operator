// Unit test for the interactive GUI-host table: built-in matchers (cwd marker wins over
// source), surfaceEmpty, owner `add` extension, the bad-entry guard, and invalid-config
// fallback. The classifier's behavior over these hosts is covered end-to-end in scan.integration.test.ts;
// this pins the data layer (and the flexibility — a new GUI is one config/array entry).
//   tsx src/gui-hosts.test.ts

import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGuiHosts, guiHostForCwd, interactiveHost } from "./gui-hosts.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-gui-hosts-"));

try {
  // Built-ins: the two worktree GUIs + the source-owned one. A new GUI is one entry here.
  const hosts = loadGuiHosts(ooHome);
  assert.deepEqual(
    hosts.map((h) => h.ui).sort(),
    ["Conductor", "PostHog Code", "Superset App"],
    "built-in hosts present",
  );

  // cwd-marker match: a session living under the GUI's worktree dir resolves to that GUI.
  assert.equal(guiHostForCwd(join(homedir(), "conductor", "workspaces", "repo", "codename"), hosts)?.ui, "Conductor", "Conductor rooted host");
  assert.equal(guiHostForCwd(join(homedir(), ".superset", "worktrees", "sb", "repo"), hosts)?.ui, "Superset App", "Superset rooted host");
  assert.equal(guiHostForCwd("/Users/x/dev/plain-repo", hosts), null, "plain cwd → no worktree host");
  assert.equal(guiHostForCwd(null, hosts), null, "no cwd → null, never throws");

  // interactiveHost: cwd marker wins over source (a Codex/Claude session in a Conductor
  // workspace IS Conductor), then falls back to source, else null (launch-mode rule applies).
  assert.equal(interactiveHost(join(homedir(), "conductor", "workspaces", "r", "c"), "codex", hosts)?.ui, "Conductor", "worktree wins over source");
  const ph = interactiveHost("/Users/x/dev/anything", "posthog-code", hosts)!;
  assert.equal(ph.ui, "PostHog Code", "source match when no cwd marker");
  assert.equal(ph.surfaceEmpty, true, "PostHog Code surfaces even with zero conversation");
  assert.equal(interactiveHost("/Users/x/dev/plain", "claude", hosts), null, "plain Claude session → no host → worker heuristics apply");
  assert.notEqual(interactiveHost(join(homedir(), "conductor", "workspaces", "r", "c"), "claude", hosts)?.surfaceEmpty, true, "worktree host does NOT surface empty (needs a real turn)");

  // Owner `add`: extend with a custom GUI by cwd marker — the flexibility a new IDE needs,
  // no code change. Needs a ui name + at least one matcher; junk entries are dropped.
  writeFileSync(join(ooHome, "gui_hosts.json"), JSON.stringify({
    add: [
      { cwdMarker: "/myide/workspaces/", ui: "My IDE" },
      { source: "claude", ui: "Always-On Claude", surfaceEmpty: true },
      { ui: "No Matcher" },              // dropped — nothing to match on
      { cwdMarker: "/x/" },              // dropped — no ui name
    ],
  }));
  const extended = loadGuiHosts(ooHome);
  assert.equal(guiHostForCwd("/Users/x/myide/workspaces/proj", extended)?.ui, "My IDE", "custom cwd-marker host honored");
  assert.equal(interactiveHost("/tmp/whatever", "claude", extended)?.ui, "Always-On Claude", "custom source host honored");
  assert.ok(!extended.some((h) => h.ui === "No Matcher"), "host with no matcher dropped");
  assert.ok(!extended.some((h) => h.cwdMarker === "/x/" && !h.ui), "host with no ui dropped");
  assert.equal(extended.filter((h) => h.ui === "Conductor").length, 1, "built-ins still present alongside adds");

  // Invalid JSON → built-ins only (never throws).
  writeFileSync(join(ooHome, "gui_hosts.json"), "{ not json");
  assert.deepEqual(
    loadGuiHosts(ooHome).map((h) => h.ui).sort(),
    ["Conductor", "PostHog Code", "Superset App"],
    "invalid config falls back to built-ins",
  );

  process.stdout.write("ok — gui-hosts: built-ins, cwd-marker wins over source, surfaceEmpty, owner add, bad-entry guard, invalid fallback\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}
