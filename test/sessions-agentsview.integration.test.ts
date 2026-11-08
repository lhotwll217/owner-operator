// Integration: the session-search wrapper uses a running agentsview daemon for discovery and
// falls back to session-grep when it is absent. A fake `agentsview` on PATH answers
// `serve status`, and a fake HTTP API returns canned hits over real transcript fixtures, so the
// test proves the mapping from agentsview hits to Owner Operator's own ids, message indexes,
// blacklist, and drill-in pointers without a real agentsview. Needs ripgrep, like the wrapper.
import assert from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rg = spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).stdout.trim();
if (!rg) {
  process.stdout.write("skip — ripgrep (rg) not installed; the session-search wrapper needs it\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(here, "..", "src/session-search/session-search.mjs");
const NEEDLE = "ZZAGENTSVIEWNEEDLEZZ";

const home = mkdtempSync(join(tmpdir(), "oo-av-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-av-oohome-"));
const bins = mkdtempSync(join(tmpdir(), "oo-av-bin-"));
const line = (record: object) => `${JSON.stringify(record)}\n`;

// Claude: an assistant turn whose text carries the needle and whose later tool_use record
// carries agentsview's timestamp for the merged message.
const okCwd = join(home, "dev", "repo");
const claudeId = "aaaa1111-2222-3333-4444-555555555555";
const claudeDir = join(home, ".claude", "projects", okCwd.replace(/[^A-Za-z0-9-]/g, "-"));
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, `${claudeId}.jsonl`),
  line({ type: "user", cwd: okCwd, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "where did we land?" } }) +
  line({ type: "assistant", cwd: okCwd, timestamp: "2026-10-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: `We landed on ${NEEDLE} for the launch agent.` }] } }) +
  line({ type: "assistant", cwd: okCwd, timestamp: "2026-10-01T10:00:07.250Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }) +
  line({ type: "user", cwd: okCwd, timestamp: "2026-10-01T10:00:08.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "README.md" }] } }) +
  line({ type: "user", cwd: okCwd, timestamp: "2026-10-01T10:01:00.000Z", message: { role: "user", content: "thanks" } }) +
  // An injected skill body, which session-grep does not search without --include-skill-bodies.
  line({ type: "user", cwd: okCwd, timestamp: "2026-10-01T10:02:00.000Z", message: { role: "user", content: `Base directory for this skill: /skills/demo\n\nUse ${NEEDLE} carefully.` } }));

// Blacklisted: same shape, cwd inside the private tree.
const privateRoot = join(home, "Private");
writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateRoot], repos: [] }));
const privateId = "bbbb1111-2222-3333-4444-555555555555";
mkdirSync(join(home, ".claude", "projects", "misc"), { recursive: true });
writeFileSync(join(home, ".claude", "projects", "misc", `${privateId}.jsonl`),
  line({ type: "user", cwd: join(privateRoot, "x"), timestamp: "2026-10-02T10:00:00.000Z", message: { role: "user", content: `private ${NEEDLE}` } }));

// Blacklisted by project folder alone: no record carries a cwd, as in some Claude transcripts.
const slugId = "ffff1111-2222-3333-4444-555555555555";
const slugDir = join(home, ".claude", "projects", privateRoot.replace(/[^A-Za-z0-9-]/g, "-"));
mkdirSync(slugDir, { recursive: true });
writeFileSync(join(slugDir, `${slugId}.jsonl`),
  line({ type: "user", timestamp: "2026-10-02T11:00:00.000Z", message: { role: "user", content: `folder ${NEEDLE}` } }));

// Codex: a custom tool call agentsview files as message text; session-grep calls it a tool entry.
const codexId = "cccc1111-2222-3333-4444-555555555555";
const codexDir = join(home, ".codex", "sessions", "2026", "10", "03");
mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, `rollout-2026-10-03T10-00-00-${codexId}.jsonl`),
  line({ type: "session_meta", timestamp: "2026-10-03T10:00:00.000Z", payload: { id: codexId, cwd: okCwd } }) +
  line({ type: "response_item", timestamp: "2026-10-03T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] } }) +
  line({ type: "response_item", timestamp: "2026-10-03T10:00:02.000Z", payload: { type: "custom_tool_call", name: "exec", input: `echo ${NEEDLE}` } }));

// Owner Operator history: Pi format, `<timestamp>_<stable-id>.jsonl`.
const ooId = "dddd1111-2222-3333-4444-555555555555";
mkdirSync(join(ooHome, "sessions"), { recursive: true });
writeFileSync(join(ooHome, "sessions", `2026-10-04T10-00-00-000Z_${ooId}.jsonl`),
  line({ type: "session", version: 3, id: ooId, timestamp: "2026-10-04T10:00:00.000Z", cwd: okCwd }) +
  line({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-04T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: `Owner Operator saw ${NEEDLE}` }] } }));

const hits = [
  // agentsview stamps the merged turn with its last record and trims trailing zeros.
  { session_id: claudeId, agent: "claude", location: "message", role: "assistant", ordinal: 1, timestamp: "2026-10-01T10:00:07.25Z", snippet: `landed on ${NEEDLE} for the` },
  { session_id: privateId, agent: "claude", location: "message", role: "user", ordinal: 0, timestamp: "2026-10-02T10:00:00Z", snippet: `private ${NEEDLE}` },
  { session_id: `codex:${codexId}`, agent: "codex", location: "message", role: "assistant", ordinal: 1, timestamp: "2026-10-03T10:00:02Z", snippet: `echo ${NEEDLE}` },
  { session_id: `pi:${ooId}`, agent: "pi", location: "message", role: "assistant", ordinal: 0, timestamp: "2026-10-04T10:00:01Z", snippet: `saw ${NEEDLE}` },
  { session_id: claudeId, agent: "claude", location: "message", role: "user", ordinal: 4, timestamp: "2026-10-01T10:02:00Z", snippet: `Use ${NEEDLE} carefully` },
  { session_id: slugId, agent: "claude", location: "message", role: "user", ordinal: 0, timestamp: "2026-10-02T11:00:00Z", snippet: `folder ${NEEDLE}` },
  { session_id: "codex:eeee1111-2222-3333-4444-555555555555", agent: "codex", location: "message", role: "user", ordinal: 0, timestamp: "2026-10-05T10:00:00Z", snippet: NEEDLE },
];

const requests: URL[] = [];
const intents: (string | undefined)[] = [];
let failSemantic = false;
let malformed = false;
// A test-specific answer to one request; the default serves every hit on a single page.
let respond: ((url: URL) => object) | null = null;
const server = createServer((req: IncomingMessage, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  requests.push(url);
  intents.push(req.headers["x-agentsview-search-intent"] as string | undefined);
  res.setHeader("content-type", "application/json");
  if (failSemantic && url.searchParams.get("mode") === "semantic") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "semantic search is not enabled" }));
    return;
  }
  res.end(JSON.stringify(malformed ? { unexpected: "shape" } : respond ? respond(url) : { matches: hits, next_cursor: 0 }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A fake agentsview CLI: `serve status` reports the fake daemon, or none.
const fakeBin = join(bins, "running");
const stoppedBin = join(bins, "stopped");
const noBin = join(bins, "absent");
const refusedBin = join(bins, "refused");
for (const dir of [fakeBin, stoppedBin, noBin, refusedBin]) {
  mkdirSync(dir);
  symlinkSync(rg, join(dir, "rg"));
}
writeFileSync(join(fakeBin, "agentsview"), `#!/bin/sh\necho "agentsview running at ${apiUrl}"\n`);
writeFileSync(join(stoppedBin, "agentsview"), "#!/bin/sh\necho \"No agentsview server is running.\"\n");
// `serve status` reports a daemon whose port refuses connections (a stale status, or a crash).
const closed = createServer();
await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
await new Promise<void>((resolve) => closed.close(() => resolve()));
writeFileSync(join(refusedBin, "agentsview"), `#!/bin/sh\necho "agentsview running at ${closedUrl}"\n`);
for (const dir of [fakeBin, stoppedBin, refusedBin]) chmodSync(join(dir, "agentsview"), 0o755);

const run = (bin: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [WRAPPER, ...args], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome, PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  }, (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
});
const json = async (bin: string, args: string[]) => {
  const result = await run(bin, [...args, "--json"]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
};

try {
  const found = await json(fakeBin, ["--query", NEEDLE]);
  assert.deepEqual(found.backend, { name: "agentsview", mode: "substring" }, "a running daemon serves discovery");
  const request = requests.at(-1)!;
  assert.equal(request.pathname, "/api/v1/search/content");
  assert.equal(request.searchParams.get("in"), "messages,thinking", "tool content stays out unless --include-tools");
  assert.equal(request.searchParams.get("agent"), "claude,codex,pi", "only formats session-grep can open");
  assert.equal(request.searchParams.get("include_children"), "true", "subagent transcripts are searched, as session-grep does");

  const byId = new Map(found.matches.map((match: { id: string }) => [match.id, match]));
  const claude = byId.get(claudeId) as { index: number; namespace: string; match: { text: string } };
  assert.equal(claude.index, 1, "a merged-turn hit maps to the record holding the text, numbered as session-grep numbers it");
  assert.match(claude.match.text, new RegExp(NEEDLE));
  assert.equal(claude.namespace, "coding");
  const oo = byId.get(ooId) as { source: string; namespace: string };
  assert.deepEqual([oo.source, oo.namespace], ["pi", "owner-operator"], "a pi: id resolves to Owner Operator's store by its stable id");
  assert.ok(!byId.has(privateId), "blacklisted transcripts are dropped");
  assert.equal(found.blacklistedDropped, 2, "a blacklisted project folder is dropped even without a cwd");
  assert.ok(!byId.has(slugId));
  assert.equal(found.skillBodyHitsDropped, 1, "an injected skill body stays out, as on session-grep");
  assert.ok(!byId.has(codexId), "tool input agentsview files as message text stays out without --include-tools");
  assert.equal(found.toolHitsDropped, 1);
  assert.equal(found.outsideSourcesDropped, 1, "a session with no readable transcript in the configured sources is dropped");

  const window = await run(fakeBin, ["--session", claudeId, "--at", String(claude.index), "--before", "0", "--after", "0"]);
  assert.match(window.stdout, new RegExp(`\\[1\\]\\* assistant [^\\n]*${NEEDLE}`), "the hit's id and idx reopen the same message");

  const withTools = await json(fakeBin, ["--query", NEEDLE, "--include-tools"]);
  assert.equal(requests.at(-1)!.searchParams.get("in"), null, "--include-tools searches every agentsview source");
  assert.ok(withTools.matches.some((match: { id: string; index: number }) => match.id === codexId && match.index === 1),
    "with --include-tools the Codex tool call is a hit at its session-grep index");

  const text = await run(fakeBin, ["--query", NEEDLE]);
  assert.match(text.stdout, /^query="ZZAGENTSVIEWNEEDLEZZ" backend=agentsview mode=substring shown=2 /,
    "the text header names the backend and reports lower bounds, not totals");
  assert.match(text.stdout, /tool_hits_dropped=1 \(add --include-tools\)/);

  await json(fakeBin, ["--query", "launch agent", "--hybrid"]);
  assert.equal(requests.at(-1)!.searchParams.get("mode"), "hybrid");
  assert.equal(intents.at(-1), "semantic", "semantic and hybrid requests carry agentsview's intent header");

  await json(fakeBin, ["--query", NEEDLE, "--until", "2026-10-02"]);
  assert.equal(requests.at(-1)!.searchParams.get("date_to"), new Date(2026, 9, 3).toISOString().slice(0, 10),
    "--until scopes agentsview's sessions, so older matches are not paged away");

  // Paging: hits dropped by policy or mapping make the wrapper read the next page.
  const outside = (n: number) => ({ ...hits[6], session_id: `codex:eeee${n}111-2222-3333-4444-555555555555` });
  let mark = requests.length;
  respond = (url) => {
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    return cursor < 2 ? { matches: [outside(cursor)], next_cursor: cursor + 1 } : { matches: [hits[0]], next_cursor: 0 };
  };
  const paged = await json(fakeBin, ["--query", NEEDLE, "--limit", "1"]);
  assert.deepEqual(requests.slice(mark).map((url) => url.searchParams.get("cursor")), [null, "1", "2"],
    "each page sends the previous page's next_cursor");
  assert.deepEqual(paged.matches.map((match: { id: string }) => match.id), [claudeId], "a hit on a later page is found");
  assert.equal(paged.outsideSourcesDropped, 2, "drops are counted across pages");
  assert.equal(paged.moreAvailable, false, "the last page reports no more results");

  mark = requests.length;
  respond = (url) => ({ matches: [outside(1)], next_cursor: Number(url.searchParams.get("cursor") ?? 0) + 1 });
  const capped = await run(fakeBin, ["--query", NEEDLE]);
  assert.equal(requests.length - mark, 4, "paging stops after four pages");
  assert.match(capped.stdout, / shown=0 message_matches_at_least=0 more_available=true /,
    "a capped search reports that agentsview has more");

  mark = requests.length;
  respond = () => ({ matches: [hits[0]], next_cursor: 9 });
  const satisfied = await json(fakeBin, ["--query", NEEDLE, "--limit", "1"]);
  assert.equal(requests.length - mark, 1, "paging stops once --limit hits are located");
  assert.equal(satisfied.moreAvailable, true);
  respond = null;

  // Request parameters for the flags agentsview filters on.
  await json(fakeBin, ["--query", NEEDLE, "--since", "2026-10-01"]);
  assert.equal(requests.at(-1)!.searchParams.get("active_since"), new Date(2026, 9, 1).toISOString(),
    "--since sends the local start of that day as active_since");
  await json(fakeBin, ["--query", "ZZAGENTS.*NEEDLE", "--regex"]);
  assert.deepEqual([requests.at(-1)!.searchParams.get("mode"), requests.at(-1)!.searchParams.get("pattern")],
    ["regex", "(?i)ZZAGENTS.*NEEDLE"], "--regex runs case-insensitive, as session-grep does");
  await json(fakeBin, ["--query", "(?i)ZZAGENTS.*NEEDLE", "--regex"]);
  assert.equal(requests.at(-1)!.searchParams.get("pattern"), "(?i)ZZAGENTS.*NEEDLE", "an explicit (?i) is not doubled");
  const codexOnly = await json(fakeBin, ["--query", NEEDLE, "--target-type", "codex", "--include-tools"]);
  assert.equal(requests.at(-1)!.searchParams.get("agent"), "codex", "--target-type narrows agentsview's agent filter");
  assert.equal(codexOnly.backend.name, "agentsview");
  // agentsview's content search has no role filter, so --role is applied to each located message.
  const assistant = await json(fakeBin, ["--query", NEEDLE, "--role", "assistant"]);
  const user = await json(fakeBin, ["--query", NEEDLE, "--role", "user"]);
  assert.ok(assistant.matches.some((match: { id: string }) => match.id === claudeId));
  assert.ok(!user.matches.some((match: { id: string }) => match.id === claudeId), "--role drops hits on the other role");

  // A semantic hit whose snippet carries no text cannot be located; it must not map to whatever
  // message sits at its timestamp.
  respond = () => ({ matches: [{ ...hits[0], timestamp: "2026-10-01T10:01:00Z", snippet: "" }], next_cursor: 0 });
  const blank = await json(fakeBin, ["--query", "where we landed", "--semantic"]);
  assert.deepEqual(blank.matches, [], "a hit with an empty snippet is not mapped to an arbitrary message");
  assert.equal(blank.unmappedDropped, 1, "it is dropped and counted");
  respond = null;

  const refused = await json(refusedBin, ["--query", NEEDLE]);
  assert.equal(refused.backend.name, "session-grep", "a reported daemon that refuses connections falls back");
  assert.match(refused.backend.note, /^agentsview search failed: /);
  assert.ok(refused.matches.some((match: { id: string }) => match.id === claudeId));

  const sent = requests.length;
  const noQuery = await run(fakeBin, ["--since", "30d"]);
  assert.equal(requests.length, sent, "a search without --query never reaches agentsview");
  assert.doesNotMatch(noQuery.stdout, /backend=agentsview/);

  malformed = true;
  const badBody = await json(fakeBin, ["--query", NEEDLE]);
  assert.equal(badBody.backend.name, "session-grep", "a response without matches falls back instead of reading as no hits");
  assert.match(badBody.backend.note, /unexpected search response/);
  malformed = false;

  failSemantic = true;
  const semanticFailed = await json(fakeBin, ["--query", NEEDLE, "--semantic"]);
  assert.equal(semanticFailed.backend.name, "session-grep", "an agentsview error falls back to session-grep");
  assert.match(semanticFailed.backend.note, /semantic search is not enabled; --semantic ran as --any/);
  failSemantic = false;

  const stopped = await json(stoppedBin, ["--query", NEEDLE]);
  assert.deepEqual(stopped.backend, { name: "session-grep", note: "agentsview not running" });
  assert.ok(stopped.matches.some((match: { id: string }) => match.id === claudeId), "fallback keeps today's results");
  const absent = await json(noBin, ["--query", NEEDLE]);
  assert.deepEqual(absent.backend, { name: "session-grep", note: "agentsview not installed" });
  const any = await json(fakeBin, ["--query", `${NEEDLE} other`, "--any"]);
  assert.deepEqual(any.backend, { name: "session-grep", note: "agentsview does not support --any" });
  const pinned = await json(fakeBin, ["--query", NEEDLE, "--backend", "session-grep"]);
  assert.deepEqual(pinned.backend, { name: "session-grep" }, "--backend session-grep skips detection");

  const forced = await run(stoppedBin, ["--query", NEEDLE, "--backend", "agentsview"]);
  assert.notEqual(forced.code, 0, "--backend agentsview fails rather than silently falling back");
  assert.match(forced.stderr, /agentsview not running/);
  process.stdout.write("ok — agentsview backend maps hits to session-grep pointers and falls back cleanly\n");
} finally {
  server.close();
  for (const dir of [home, ooHome, bins]) rmSync(dir, { recursive: true, force: true });
}
