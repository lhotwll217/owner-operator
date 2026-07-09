// Integration test of the scan skill — the REAL scan-active-transcripts script against fake
// session files (Claude + Cursor + PostHog Code + pi + opencode + Antigravity + Grok Build),
// and a real throwaway git repo. Proves: the transcript-fact contract at the scanner surface,
// drill-in answers, each source's finder (Cursor slug → cwd reconstruction, PostHog Code
// ACP log → thread, opencode info + message/part join, Antigravity brain transcript, pi
// header + entries, Grok Build best-effort), origin-app detection, launch-mode classification
// (a Conductor SDK session surfaces; a non-GUI SDK worker stays hidden), and the git ± delta.
//   npm run test:integration      (from repo root)

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCAN = join(here, "..", "src/session-monitor/scan-active-transcripts.mjs");

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

// Cursor sub-task agent — its own transcript under the parent's `subagents/` dir. Must fold into the
// core session (same parent id), not split it into a separate thread.
const cursorSubFile = join(home, ".cursor", "projects", slug, "agent-transcripts", cid, "subagents", "abababab-cccc-dddd-eeee-ffffffffffff.jsonl");
mkdirSync(dirname(cursorSubFile), { recursive: true });
writeFileSync(
  cursorSubFile,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>add a unit test for the backoff</user_query>" }] } }) + "\n" +
  JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Backoff test added." }] } }) + "\n",
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

// pi session: format v3 JSONL — a {type:"session"} header (id + cwd) then {type:"message"}
// entries wrapping AgentMessages. Assistant stopReason "stop" = yielded → needs-you.
const piId = "01980000-1111-2222-3333-444444444444";
const piCwd = join(home, "dev", "pi-app");
mkdirSync(piCwd, { recursive: true });
const piFile = join(home, ".pi", "agent", "sessions", `--${piCwd.slice(1).replace(/[/\\:]/g, "-")}--`, `2026-01-01T00-00-00-000Z_${piId}.jsonl`);
mkdirSync(dirname(piFile), { recursive: true });
writeFileSync(
  piFile,
  JSON.stringify({ type: "session", version: 3, id: piId, timestamp: at(50), cwd: piCwd }) + "\n" +
  JSON.stringify({ type: "message", id: "aaaa0001", parentId: null, timestamp: at(26), message: { role: "user", content: "add retry backoff to the fetcher" } }) + "\n" +
  JSON.stringify({ type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp: at(21), message: { role: "assistant", content: [{ type: "text", text: "Backoff added with jitter; fetcher retries clean." }], stopReason: "stop" } }) + "\n",
);

// opencode session (gen-2 layout): the per-session info JSON is the scanned candidate; turns
// are one-JSON-per-message with the text in one-JSON-per-part files. Assistant
// time.completed present → yielded.
const ocId = "ses_scantest0001";
const ocCwd = join(home, "dev", "oc-app");
mkdirSync(ocCwd, { recursive: true });
const ocStorage = join(home, ".local", "share", "opencode", "storage");
const ocMs = (minAgo: number) => Date.now() - minAgo * 60_000;
mkdirSync(join(ocStorage, "session", "proj_x"), { recursive: true });
writeFileSync(join(ocStorage, "session", "proj_x", `${ocId}.json`), JSON.stringify({
  id: ocId, projectID: "proj_x", directory: ocCwd, title: "job queue refactor", version: "1.0.0",
  time: { created: ocMs(28), updated: ocMs(9) },
}));
mkdirSync(join(ocStorage, "message", ocId), { recursive: true });
mkdirSync(join(ocStorage, "part", "msg_a"), { recursive: true });
mkdirSync(join(ocStorage, "part", "msg_b"), { recursive: true });
writeFileSync(join(ocStorage, "message", ocId, "msg_a.json"),
  JSON.stringify({ id: "msg_a", sessionID: ocId, role: "user", time: { created: ocMs(28) } }));
writeFileSync(join(ocStorage, "part", "msg_a", "prt_1.json"),
  JSON.stringify({ id: "prt_1", sessionID: ocId, messageID: "msg_a", type: "text", text: "refactor the job queue" }));
writeFileSync(join(ocStorage, "message", ocId, "msg_b.json"),
  JSON.stringify({ id: "msg_b", sessionID: ocId, role: "assistant", time: { created: ocMs(10), completed: ocMs(9) }, path: { cwd: ocCwd, root: ocCwd } }));
writeFileSync(join(ocStorage, "part", "msg_b", "prt_2.json"),
  JSON.stringify({ id: "prt_2", sessionID: ocId, messageID: "msg_b", type: "text", text: "Queue refactored; workers drain cleanly." }));

// Antigravity brain transcript: one step per line. USER_EXPLICIT USER_INPUT = the owner,
// PLANNER_RESPONSE = the agent; the brain/<id> dir is the session id. The history.jsonl
// index beside brain/ shares the extension but is NOT a session — it must be filtered out.
const agId = "conv-scantest-1";
const agRoot = join(home, ".gemini", "antigravity-cli");
const agLogs = join(agRoot, "brain", agId, ".system_generated", "logs");
mkdirSync(agLogs, { recursive: true });
const agStep = (i: number, source: string, type: string, content: string, ts: string) =>
  JSON.stringify({ step_index: i, source, type, status: "DONE", content, created_at: ts }) + "\n";
writeFileSync(join(agLogs, "transcript.jsonl"),
  agStep(0, "USER_EXPLICIT", "USER_INPUT", "profile the slow dashboard query", at(22)) +
  agStep(1, "MODEL", "PLANNER_RESPONSE", "Query profiled — missing index on events.team_id.", at(18)));
writeFileSync(join(agRoot, "history.jsonl"),
  agStep(0, "USER_EXPLICIT", "USER_INPUT", "history index — must not become a thread", at(5)));

// Grok Build: only the root (~/.grok/sessions, organized by cwd) is documented — the parser
// is best-effort over chat-turn-shaped records. Id falls back to the file stem.
const grokId = "grok-sess-1";
const grokCwd = join(home, "dev", "grok-app");
mkdirSync(grokCwd, { recursive: true });
const grokFile = join(home, ".grok", "sessions", "home-dev-grok-app", `${grokId}.jsonl`);
mkdirSync(dirname(grokFile), { recursive: true });
writeFileSync(grokFile,
  JSON.stringify({ timestamp: at(16), cwd: grokCwd, message: { role: "user", content: "tighten the rate limiter" } }) + "\n" +
  JSON.stringify({ timestamp: at(12), message: { role: "assistant", content: [{ type: "text", text: "Rate limiter tightened." }] } }) + "\n");

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
  assert.equal(fresh.count, 11, "scan finds the Claude, Cursor, PostHog Code (local + cloud), Conductor, pi, opencode, Antigravity, and Grok Build sessions");
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
  assert.equal(byId(fresh, "abababab-cccc-dddd-eeee-ffffffffffff"), undefined, "Cursor sub-task transcript folds into its core session, not its own thread");
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

  // The pi finder: header cwd → repo, blocks-or-string content, stopReason "stop" = yielded.
  const pi = byId(fresh, piId)!;
  assert.equal(pi.ui, "pi", "pi source → pi app");
  assert.equal(pi.repo, "pi-app", "repo from the session header cwd");
  assert.equal(pi.state, "needs-you", "assistant yielded (stopReason stop) → needs-you");
  assert.ok(pi.topic.includes("retry backoff"), "topic from the first user turn");

  // The opencode finder: info record → thread; message + part files join into turns.
  const oc = byId(fresh, ocId)!;
  assert.equal(oc.ui, "opencode", "opencode source → opencode app");
  assert.equal(oc.repo, "oc-app", "repo from the info record's directory");
  assert.equal(oc.state, "needs-you", "assistant time.completed present → yielded");
  assert.equal(oc.working, false, "completed assistant turn → not working");
  assert.deepEqual(oc.firstMessages.map((m) => m.role), ["user", "assistant"], "parts join into turns");
  assert.ok(oc.firstMessages[0].text.includes("refactor the job queue"), "user text from its part file");

  // The Antigravity finder: brain transcript steps → turns; the history index is filtered out.
  const ag = byId(fresh, agId)!;
  assert.equal(ag.ui, "Antigravity", "antigravity source → Antigravity app");
  assert.equal(ag.state, "needs-you", "last step DONE → not working");
  assert.ok(ag.topic.includes("slow dashboard query"), "topic from the USER_INPUT step");
  assert.ok(!fresh.threads.some((t) => t.topic.includes("history index")), "history.jsonl is not a session");

  // The Grok Build finder: best-effort chat-turn records, id from the file stem.
  const grok = byId(fresh, grokId)!;
  assert.equal(grok.ui, "Grok Build", "grok-build source → Grok Build app");
  assert.equal(grok.repo, "grok-app", "cwd from the records");
  assert.equal(grok.state, "needs-you", "assistant replied last → needs-you");

  // The inverse: a headless SDK worker in a plain cwd (no GUI host) stays hidden by default,
  // and only --all audits it. Exempting GUI hosts must not resurface real workers.
  assert.equal(byId(fresh, workerId), undefined, "non-GUI sdk-ts worker hidden by default");
  assert.ok(byId(run("--all"), workerId), "…but --all still audits the worker");

  // --sample 0 is the monitor's metadata-only mode: NO message bodies may leak through
  // (slice(-0) used to dump the entire tail).
  const meta = byId(run("--sample", "0"), sid)!;
  assert.deepEqual(
    [meta.firstMessages, meta.recentMessages, meta.omittedMessageCount],
    [[], [], 4],
    "--sample 0 carries metadata only",
  );

  // Durable owner state is deliberately absent here; the State seam owns done-hold and reopening.
  assert.equal(byId(run("--thread", sid), sid)?.state, "needs-you", "scanner reports transcript-derived state");

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
  assert.equal(run().count, 11, "visible set unchanged");
  assert.equal(run("--thread", slugId).count, 0, "--thread drill-in cannot reach a blacklisted thread");
  assert.equal(run("--thread", deepId).count, 0, "--thread drill-in cannot reach a lower-level one either");

  process.stdout.write("ok — scan skill: resolver join, per-source finders (cursor, posthog, pi, opencode, antigravity, grok), origin app, launch-mode (Conductor vs worker), git delta, blacklist\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}
