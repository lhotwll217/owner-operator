// Integration test of the scan skill — the REAL get-active-threads script against fake
// session files (Claude + Cursor + PostHog Code), a real throwaway git repo, and a fake
// status store. Proves: the canonical-resolver contract at the skill surface (done excluded
// by default, --include-done audits, drill-in answers, newer message wakes), the Cursor
// finder (slug → cwd reconstruction), the PostHog Code finder (ACP log → thread), origin-app
// detection (Superset/Cursor/PostHog Code/Conductor), launch-mode classification (a Conductor
// SDK session surfaces; a non-GUI SDK worker stays hidden), and the git ± delta.
//   npm run test:scan      (from harness/)

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCAN = join(here, "..", "..", ".agents/skills/get-active-threads/get-active-threads.mjs");

const home = mkdtempSync(join(tmpdir(), "oo-scan-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-scan-store-"));

const sid = "11111111-2222-3333-4444-555555555555";
const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
// Claude session, spawned in a (fake) Superset worktree → App resolves to "Superset App".
const claudeCwd = join(home, ".superset", "worktrees", "sb", "demo-repo");
const sessionFile = join(home, ".claude", "projects", "demo", `${sid}.jsonl`);
const msg = (type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({ type, sessionId: sid, cwd: claudeCwd, timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";

mkdirSync(dirname(sessionFile), { recursive: true });
writeFileSync(
  sessionFile,
  msg("user", "ship the resolver fix", at(30)) +
  msg("assistant", "On it — wiring the resolver.", at(25)) +
  msg("user", "looks good, add tests too", at(20)) +
  msg("assistant", "Tests added; resolver join is wired.", at(10)),
);

// Cursor session in a REAL git repo whose path contains dashes (the slug-reconstruction
// edge) and a +3 −1 working-tree delta vs HEAD.
const repoDir = join(home, "dev", "demo-app-x");
mkdirSync(repoDir, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-C", repoDir, ...a], {
  env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  stdio: ["ignore", "pipe", "pipe"],
});
git("init", "-q");
writeFileSync(join(repoDir, "f.txt"), "a\nb\nc\n");
git("add", ".");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
writeFileSync(join(repoDir, "f.txt"), "a\nB\nc\nd\ne\n"); // change 1 line, add 2 → +3 −1

const cid = "99999999-8888-7777-6666-555555555555";
const slug = repoDir.slice(1).split("/").join("-"); // Cursor's cwd → dir-name slugging
const cursorFile = join(home, ".cursor", "projects", slug, "agent-transcripts", cid, `${cid}.jsonl`);
mkdirSync(dirname(cursorFile), { recursive: true });
writeFileSync(
  cursorFile,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>tighten the retry loop</user_query>" }] } }) + "\n" +
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Retry loop tightened; tests pass." }] } }) + "\n",
);

// Plain workspace stacked on a non-main base branch. The old scanner always tried
// origin/main first, which made the diff include the release branch's own line.
const stackedRepoDir = join(home, "dev", "feature-from-release");
mkdirSync(stackedRepoDir, { recursive: true });
const stackedGit = (...a: string[]) => execFileSync("git", ["-C", stackedRepoDir, ...a], {
  env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  stdio: ["ignore", "pipe", "pipe"],
});
stackedGit("init", "-q");
writeFileSync(join(stackedRepoDir, "f.txt"), "root\n");
stackedGit("add", ".");
stackedGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "main");
stackedGit("branch", "-M", "main");
stackedGit("update-ref", "refs/remotes/origin/main", stackedGit("rev-parse", "HEAD").toString().trim());
stackedGit("checkout", "-qb", "release");
writeFileSync(join(stackedRepoDir, "f.txt"), "root\nrelease\n");
stackedGit("add", ".");
stackedGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "release");
stackedGit("update-ref", "refs/remotes/origin/release", stackedGit("rev-parse", "HEAD").toString().trim());
stackedGit("checkout", "-qb", "feature-from-release");
stackedGit("config", "branch.feature-from-release.base", "release");
writeFileSync(join(stackedRepoDir, "f.txt"), "root\nrelease\nfeature\n");
stackedGit("add", ".");
stackedGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "feature");
writeFileSync(join(stackedRepoDir, "f.txt"), "root\nrelease\nfeature\nworking\n");

const stackedId = "77777777-6666-5555-4444-333333333333";
const stackedSlug = stackedRepoDir.slice(1).split("/").join("-");
const stackedFile = join(home, ".cursor", "projects", stackedSlug, "agent-transcripts", stackedId, `${stackedId}.jsonl`);
mkdirSync(dirname(stackedFile), { recursive: true });
writeFileSync(
  stackedFile,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>stack this on release</user_query>" }] } }) + "\n" +
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Feature change is ready on the release stack." }] } }) + "\n",
);

// Same branch shape, but no branch.<name>.base metadata. The scanner should omit the badge
// instead of guessing origin/main and showing a misleading delta.
const unknownBaseRepoDir = join(home, "dev", "unknown-base-feature");
mkdirSync(unknownBaseRepoDir, { recursive: true });
const unknownGit = (...a: string[]) => execFileSync("git", ["-C", unknownBaseRepoDir, ...a], {
  env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  stdio: ["ignore", "pipe", "pipe"],
});
unknownGit("init", "-q");
writeFileSync(join(unknownBaseRepoDir, "f.txt"), "root\n");
unknownGit("add", ".");
unknownGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "main");
unknownGit("branch", "-M", "main");
unknownGit("update-ref", "refs/remotes/origin/main", unknownGit("rev-parse", "HEAD").toString().trim());
unknownGit("checkout", "-qb", "release");
writeFileSync(join(unknownBaseRepoDir, "f.txt"), "root\nrelease\n");
unknownGit("add", ".");
unknownGit("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "release");
unknownGit("update-ref", "refs/remotes/origin/release", unknownGit("rev-parse", "HEAD").toString().trim());
unknownGit("checkout", "-qb", "feature-without-base");
writeFileSync(join(unknownBaseRepoDir, "f.txt"), "root\nrelease\nfeature\n");

const unknownBaseId = "22222222-3333-4444-5555-666666666666";
const unknownBaseSlug = unknownBaseRepoDir.slice(1).split("/").join("-");
const unknownBaseFile = join(home, ".cursor", "projects", unknownBaseSlug, "agent-transcripts", unknownBaseId, `${unknownBaseId}.jsonl`);
mkdirSync(dirname(unknownBaseFile), { recursive: true });
writeFileSync(
  unknownBaseFile,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>unknown base branch</user_query>" }] } }) + "\n" +
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Ready, but the branch has no base metadata." }] } }) + "\n",
);

// PostHog Code session: the ACP (Agent Client Protocol) JSON-RPC stream in `logs.ndjson` —
// session/new (cwd + taskRunId), session/prompt (user turn), agent_message chunks (assistant
// narration, coalesced to one turn), and the session/prompt result (stopReason = turn done).
const phId = "33333333-4444-5555-6666-777777777777";
const phCwd = join(home, "dev", "ph-demo"); // no git here → no diff badge
const phNote = (notification: unknown, ts: string) => JSON.stringify({ type: "notification", timestamp: ts, notification }) + "\n";
const phFile = join(home, ".posthog-code", "sessions", phId, "logs.ndjson");
mkdirSync(dirname(phFile), { recursive: true });
writeFileSync(
  phFile,
  phNote({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: phCwd, _meta: { taskRunId: phId } } }, at(15)) +
  phNote({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { prompt: [{ type: "text", text: "wire up google ads in posthog" }] } }, at(15)) +
  phNote({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message", content: { type: "text", text: "Looking into the integration." } } } }, at(14)) +
  phNote({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking out loud — should not surface" } } } }, at(14)) +
  phNote({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message", content: { type: "text", text: "Google Ads is a native source." } } } }, at(13)) +
  phNote({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", usage: { totalTokens: 1234 } } }, at(13)),
);

// PostHog Code CLOUD task still provisioning a sandbox: no session/new, no cwd, no
// conversation — identity/repo/status live only in _posthog/* telemetry. Must still surface
// (as a working "cloud" thread) instead of being dropped for having no messages.
const phCloudId = "44444444-5555-6666-7777-888888888888";
const phCloudFile = join(home, ".posthog-code", "sessions", phCloudId, "logs.ndjson");
mkdirSync(dirname(phCloudFile), { recursive: true });
writeFileSync(
  phCloudFile,
  phNote({ jsonrpc: "2.0", method: "_posthog/console", params: { sessionId: phCloudId, level: "debug", message: "Creating environment from published sandbox base image for acme/widget-site" } }, at(3)) +
  phNote({ jsonrpc: "2.0", method: "_posthog/progress", params: { sessionId: phCloudId, step: "sandbox", status: "in_progress", label: "Setting up sandbox" } }, at(2)),
);

// Conductor session: Claude driven over the SDK (entrypoint sdk-ts) inside a Conductor
// workspace. The launch-mode classifier must NOT hide it — sdk-ts is Conductor's transport,
// not a headless-worker signal. This is the regression that silently dropped EVERY Conductor
// thread (sdk-ts ⇒ automated) until the gui-hosts override; it must surface in the DEFAULT scan.
const condId = "abababab-cdcd-efef-0101-232323232323";
const condCwd = join(home, "conductor", "workspaces", "stitchr", "codename-x");
mkdirSync(condCwd, { recursive: true });
const condFile = join(home, ".claude", "projects", "cond", `${condId}.jsonl`);
mkdirSync(dirname(condFile), { recursive: true });
const sdkMsg = (id: string, cwd: string, type: "user" | "assistant", content: string, ts: string) =>
  JSON.stringify({ type, sessionId: id, cwd, entrypoint: "sdk-ts", timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";
writeFileSync(
  condFile,
  sdkMsg(condId, condCwd, "user", "fix the active-thread filter", at(40)) +
  sdkMsg(condId, condCwd, "assistant", "Looking at the scan now.", at(35)) +
  sdkMsg(condId, condCwd, "user", "yeah it hides Conductor threads", at(30)) +
  sdkMsg(condId, condCwd, "assistant", "Found it — sdk-ts was force-hidden. Patching.", at(12)),
);

// The inverse: a headless Claude SDK worker in a PLAIN cwd (no GUI host). Same sdk-ts transport,
// but nobody opened a GUI — it MUST stay hidden by default (the launch-mode rule still applies).
// Guards against the gui-hosts exemption over-surfacing real workers.
const workerId = "dcdcdcdc-baba-fafa-1010-454545454545";
const workerCwd = join(home, "dev", "headless-worker");
mkdirSync(workerCwd, { recursive: true });
const workerFile = join(home, ".claude", "projects", "worker", `${workerId}.jsonl`);
mkdirSync(dirname(workerFile), { recursive: true });
writeFileSync(
  workerFile,
  sdkMsg(workerId, workerCwd, "user", "run the nightly summary", at(40)) +
  sdkMsg(workerId, workerCwd, "assistant", "Summary complete.", at(38)) +
  sdkMsg(workerId, workerCwd, "user", "thanks", at(37)) +
  sdkMsg(workerId, workerCwd, "assistant", "Anytime.", at(36)),
);

interface ScanThread {
  id: string; state: string; lastMessageAt: string; repo: string; ui: string; environment?: string;
  topic: string; working?: boolean; diffAdded?: number; diffDeleted?: number;
  firstMessages: { role: string; text: string }[]; recentMessages: unknown[]; omittedMessageCount: number;
}
const run = (...extra: string[]): { count: number; threads: ScanThread[] } =>
  JSON.parse(execFileSync("node", [SCAN, "--since", "7d", "--json", ...extra], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));
const byId = (res: { threads: ScanThread[] }, id: string): ScanThread | undefined =>
  res.threads.find((t) => t.id === id);

try {
  // No owner state yet → all candidates pass, resolved from scan facts alone.
  const fresh = run();
  assert.equal(fresh.count, 7, "scan finds the Claude, Cursor, PostHog Code (local + cloud), and Conductor sessions");
  const claude = byId(fresh, sid)!;
  assert.equal(claude.state, "needs-you", "assistant yielded → needs-you");
  assert.equal(claude.ui, "Superset App", "worktree host wins app detection");
  assert.equal(claude.diffAdded, undefined, "no repo at the claude cwd → no delta");

  // The Cursor finder: slug → real cwd (dashes inside the leaf), origin app, git delta.
  const cursor = byId(fresh, cid)!;
  assert.equal(cursor.ui, "Cursor");
  assert.equal(cursor.repo, "demo-app-x", "dash-slug reconstructed against the real filesystem");
  assert.equal(cursor.state, "needs-you", "assistant yielded (no trailing tool_use) → needs-you");
  assert.ok(cursor.topic.includes("tighten the retry loop") && !cursor.topic.includes("<user_query>"), "topic clean of wrapper tags");
  assert.deepEqual([cursor.diffAdded, cursor.diffDeleted], [3, 1], "working-tree delta vs HEAD");
  assert.deepEqual(
    [byId(fresh, stackedId)?.diffAdded, byId(fresh, stackedId)?.diffDeleted],
    [2, 0],
    "stacked workspace delta uses branch.<name>.base",
  );
  assert.deepEqual(
    [byId(fresh, unknownBaseId)?.diffAdded, byId(fresh, unknownBaseId)?.diffDeleted],
    [undefined, undefined],
    "unknown-base workspace omits the badge instead of guessing origin/main",
  );

  // The PostHog Code finder: ACP log → thread. taskRunId is the id, cwd → repo, first prompt
  // is the topic, agent_message chunks coalesce to one assistant turn, agent_thought_chunk is
  // dropped, and the completed prompt (stopReason result) → not working → needs-you.
  const ph = byId(fresh, phId)!;
  assert.equal(ph.ui, "PostHog Code", "posthog-code source → PostHog Code app");
  assert.equal(ph.repo, "ph-demo", "repo is the cwd leaf");
  assert.ok(ph.topic.includes("wire up google ads"), "topic from the first session/prompt");
  assert.equal(ph.state, "needs-you", "completed turn, assistant last → needs-you");
  assert.equal(ph.working, false, "stopReason result present → turn not in progress");
  assert.deepEqual(ph.firstMessages.map((m) => m.role), ["user", "assistant"], "one user turn + coalesced assistant turn");
  assert.equal(
    ph.firstMessages[1].text,
    "Looking into the integration. Google Ads is a native source.",
    "agent_message chunks coalesce; agent_thought_chunk excluded",
  );

  // The cloud task surfaces despite zero conversation — repo + status from _posthog/* telemetry.
  const phCloud = byId(fresh, phCloudId)!;
  assert.equal(phCloud.ui, "PostHog Code", "cloud task is still a PostHog Code thread");
  assert.equal(phCloud.repo, "widget-site", "cloud repo from the sandbox-image line (no local cwd)");
  assert.equal(phCloud.environment, "cloud", "sandbox provisioning → cloud env");
  assert.equal(phCloud.working, true, "still provisioning → working");
  assert.ok(phCloud.topic.includes("Setting up sandbox"), "topic falls back to the progress label");

  // Conductor (Claude over the SDK in a Conductor workspace) MUST surface in the DEFAULT scan —
  // `fresh` is run() with no --all. sdk-ts is its transport, not a headless-worker signal.
  // (Regression guard: before gui-hosts, sdk-ts ⇒ automated silently dropped every Conductor thread.)
  const conductor = byId(fresh, condId)!;
  assert.equal(conductor.ui, "Conductor", "Conductor workspace → Conductor app");
  assert.equal(conductor.state, "needs-you", "assistant yielded → needs-you");
  assert.ok(conductor.topic.includes("fix the active-thread filter"), "topic from the first user turn");

  // The inverse: a headless SDK worker in a plain cwd (no GUI host) stays hidden by default,
  // and only --all audits it. Exempting GUI hosts must not resurface real workers.
  assert.equal(byId(fresh, workerId), undefined, "non-GUI sdk-ts worker hidden by default");
  assert.ok(byId(run("--all"), workerId), "…but --all still audits the worker");

  // --sample 0 is the poller's metadata-only mode: NO message bodies may leak through
  // (slice(-0) used to dump the entire tail).
  const meta = byId(run("--sample", "0"), sid)!;
  assert.deepEqual(
    [meta.firstMessages, meta.recentMessages, meta.omittedMessageCount],
    [[], [], 4],
    "--sample 0 carries metadata only",
  );

  // Operator marks the claude thread done (status.json is the store the resolver joins).
  writeFileSync(join(ooHome, "status.json"), JSON.stringify({
    polledAt: at(5),
    threads: [{ id: sid, state: "done", lastMessageAt: claude.lastMessageAt }],
  }));

  const afterDone = run();
  assert.deepEqual([afterDone.count, byId(afterDone, sid)], [6, undefined], "done thread excluded by default; others unaffected");
  const audit = run("--include-done");
  assert.deepEqual([audit.count, byId(audit, sid)?.state], [7, "done"], "--include-done audits it, resolved done");
  const drill = run("--thread", sid);
  assert.deepEqual([drill.count, drill.threads[0].state], [1, "done"], "--thread drill-in always answers");

  // A newer message lands → the same scan wakes the thread (no owner action needed).
  appendFileSync(sessionFile, msg("assistant", "One more thing came up — see the failing CI run.", at(1)));
  const woken = run();
  assert.deepEqual([woken.count, byId(woken, sid)?.state], [7, "needs-you"], "newer message wakes a done thread");

  // ---- privacy blacklist: ABSOLUTE — both layers, no flag bypasses --------------------
  const privateRoot = join(home, "Documents", "Personal");
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateRoot], repos: ["Personal"] }));
  const privMsg = (id: string, cwd: string, type: "user" | "assistant", content: string, ts: string) =>
    JSON.stringify({ type, sessionId: id, cwd, timestamp: ts, message: { content, ...(type === "assistant" ? { stop_reason: "end_turn" } : {}) } }) + "\n";
  // Layer 1: project dir named with the cwd slug → the file is skipped UNREAD.
  const slugId = "aaaaaaaa-1111-2222-3333-444444444444";
  const slugCwd = join(privateRoot, "Career");
  const slugDir = join(home, ".claude", "projects", slugCwd.replace(/[^A-Za-z0-9-]/g, "-"));
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, `${slugId}.jsonl`),
    privMsg(slugId, slugCwd, "user", "private thing", at(8)) +
    privMsg(slugId, slugCwd, "assistant", "noted", at(7)) +
    privMsg(slugId, slugCwd, "user", "more private follow-up", at(6)));
  // Layer 2: unslugged dir (worktree-style) — caught post-parse by the records' cwd.
  const deepId = "bbbbbbbb-1111-2222-3333-444444444444";
  const deepCwd = join(privateRoot, "Career", "Jobs", "acme");
  mkdirSync(join(home, ".claude", "projects", "misc"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "misc", `${deepId}.jsonl`),
    privMsg(deepId, deepCwd, "user", "private lower-level thing", at(8)) +
    privMsg(deepId, deepCwd, "assistant", "noted", at(7)) +
    privMsg(deepId, deepCwd, "user", "more of it", at(6)));

  const blocked = run("--all");
  assert.equal(byId(blocked, slugId), undefined, "blacklisted tree skipped unread (slug layer)");
  assert.equal(byId(blocked, deepId), undefined, "lower-level repo dropped post-parse — even --all");
  assert.equal(run().count, 7, "visible set unchanged");
  assert.equal(run("--thread", slugId).count, 0, "--thread drill-in cannot reach a blacklisted thread");
  assert.equal(run("--thread", deepId).count, 0, "--thread drill-in cannot reach a lower-level one either");

  process.stdout.write("ok — scan skill: resolver join, cursor finder, origin app, launch-mode (Conductor vs worker), git delta, blacklist\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}
