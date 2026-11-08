// Integration: the agentsview backend re-implements rules that are private to the vendored
// session-grep primitive, which is a CLI that cannot be imported and must not be edited locally
// (src/session-search/vendor/session-grep/UPSTREAM.md). Each rule exists twice, so this test
// runs both sides over the same transcripts and fails when they disagree:
// - message numbering and skill-body reduction: agentsview.mjs `transcriptMessages` against the
//   primitive's `--skim`, which prints every message of its `messagesFrom` view with its index;
// - the --since/--until grammar: session-search.mjs `parseSince`/`parseUntil` against the
//   primitive's, by comparing which messages each backend returns for the same window;
// - the per-hit preview budget: session-search.mjs `previewChars` against the primitive's
//   `matchPreviewChars`, by comparing the size of a long match's preview.
// Needs ripgrep, like the wrapper.
import assert from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptMessages } from "../src/session-search/agentsview.mjs";

const rg = spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).stdout.trim();
if (!rg) {
  process.stdout.write("skip — ripgrep (rg) not installed; the session-search wrapper needs it\n");
  process.exit(0);
}

// A zone away from UTC, so a local-day rule read as a UTC day lands on different messages.
process.env.TZ = "America/Chicago";
const here = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(here, "..", "src/session-search/session-search.mjs");
const PRIMITIVE = join(here, "..", "src/session-search/vendor/session-grep/session-grep.mjs");
const NEEDLE = "ZZPARITYNEEDLEZZ";

const home = mkdtempSync(join(tmpdir(), "oo-avp-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-avp-oohome-"));
const bins = mkdtempSync(join(tmpdir(), "oo-avp-bin-"));
const line = (record: object) => `${JSON.stringify(record)}\n`;
const cwd = join(home, "dev", "repo");

// One transcript per format, covering every numbering rule: records with no text take no index,
// tool entries take one but are hidden without --include-tools, and injected skill bodies are
// reduced to a placeholder.
const claudeId = "aaaa2222-2222-3333-4444-555555555555";
const claudeFile = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"), `${claudeId}.jsonl`);
const claudeRecord = (role: string, timestamp: string, content: unknown) =>
  line({ type: role, cwd, timestamp, message: { role, content } });
const codexId = "cccc2222-2222-3333-4444-555555555555";
const codexFile = join(home, ".codex", "sessions", "2026", "10", "03", `rollout-2026-10-03T10-00-00-${codexId}.jsonl`);
const codexItem = (timestamp: string, payload: object) => line({ type: "response_item", timestamp, payload });
const piId = "dddd2222-2222-3333-4444-555555555555";
const piFile = join(ooHome, "sessions", `2026-10-04T10-00-00-000Z_${piId}.jsonl`);
const piMessage = (id: string, timestamp: string, message: object) => line({ type: "message", id, parentId: null, timestamp, message });
for (const file of [claudeFile, codexFile, piFile]) mkdirSync(dirname(file), { recursive: true });

writeFileSync(claudeFile,
  claudeRecord("user", "2026-10-01T10:00:00.000Z", `start ${NEEDLE}`) +
  line({ type: "summary", summary: "not a message" }) +
  claudeRecord("assistant", "2026-10-01T10:00:01.000Z", [{ type: "thinking", thinking: `considering ${NEEDLE}` }]) +
  claudeRecord("assistant", "2026-10-01T10:00:02.000Z", [{ type: "text", text: "   " }]) +
  claudeRecord("assistant", "2026-10-01T10:00:03.000Z", [{ type: "text", text: "running it" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: `echo ${NEEDLE}` } }]) +
  claudeRecord("assistant", "2026-10-01T10:00:04.000Z", [{ type: "tool_use", id: "t2", name: "Read", input: { path: "a" } }]) +
  claudeRecord("user", "2026-10-01T10:00:05.000Z", [{ type: "tool_result", tool_use_id: "t2", content: NEEDLE }]) +
  claudeRecord("user", "2026-10-01T10:00:06.000Z", `Base directory for this skill: /skills/demo\n\nUse ${NEEDLE}.`) +
  claudeRecord("user", "2026-10-01T10:00:07.000Z", `<command-name>/demo</command-name>`) +
  claudeRecord("assistant", "2026-10-01T10:00:08.000Z", [{ type: "text", text: `done ${NEEDLE}` }]));
writeFileSync(codexFile,
  line({ type: "session_meta", timestamp: "2026-10-03T10:00:00.000Z", payload: { id: codexId, cwd } }) +
  codexItem("2026-10-03T10:00:01.000Z", { type: "message", role: "user", content: [{ type: "input_text", text: `run ${NEEDLE}` }] }) +
  codexItem("2026-10-03T10:00:02.000Z", { type: "reasoning", encrypted_content: "x" }) +
  line({ type: "event_msg", timestamp: "2026-10-03T10:00:03.000Z", payload: { type: "agent_reasoning", text: `thinking ${NEEDLE}` } }) +
  codexItem("2026-10-03T10:00:04.000Z", { type: "function_call", name: "shell", arguments: `{"cmd":"echo ${NEEDLE}"}`, call_id: "c1" }) +
  codexItem("2026-10-03T10:00:05.000Z", { type: "function_call_output", call_id: "c1", output: NEEDLE }) +
  codexItem("2026-10-03T10:00:06.000Z", { type: "custom_tool_call", name: "exec", input: `echo ${NEEDLE}` }) +
  codexItem("2026-10-03T10:00:07.000Z", { type: "message", role: "user", content: [{ type: "input_text", text: `<skill>\n<name>demo</name>\nUse ${NEEDLE}.` }] }) +
  codexItem("2026-10-03T10:00:08.000Z", { type: "message", role: "assistant", content: [{ type: "output_text", text: `done ${NEEDLE}` }] }));
writeFileSync(piFile,
  line({ type: "session", version: 3, id: piId, timestamp: "2026-10-04T10:00:00.000Z", cwd }) +
  piMessage("m1", "2026-10-04T10:00:01.000Z", { role: "user", content: [{ type: "text", text: `ask ${NEEDLE}` }] }) +
  piMessage("m2", "2026-10-04T10:00:02.000Z", { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "toolCall", id: "p1", name: "bash", arguments: { command: "ls" } }] }) +
  piMessage("m3", "2026-10-04T10:00:03.000Z", { role: "toolResult", toolCallId: "p1", content: [{ type: "text", text: NEEDLE }] }) +
  piMessage("m4", "2026-10-04T10:00:04.000Z", { role: "assistant", content: [{ type: "text", text: `answer ${NEEDLE}` }] }));

// Date windows: messages one second either side of local midnight on a fixed day, and either
// side of the two-day relative cutoff and of today's midnight.
const windowId = "eeee2222-2222-3333-4444-555555555555";
const windowFile = join(dirname(claudeFile), `${windowId}.jsonl`);
const now = Date.now();
const midnight = (year: number, month: number, day: number) => new Date(year, month, day).getTime();
const today = new Date();
const instants = [
  midnight(2026, 9, 10) - 1000, midnight(2026, 9, 10), midnight(2026, 9, 11) - 1000, midnight(2026, 9, 11),
  now - 2 * 86_400_000 - 60_000, now - 2 * 86_400_000 + 60_000,
  midnight(today.getFullYear(), today.getMonth(), today.getDate()) - 1000, now - 1000,
].sort((a, b) => a - b);
// The newest message is the preview-budget probe: far larger than any per-hit share.
const long = `${"lorem ipsum dolor ".repeat(400)}${NEEDLE}${" sit amet consectetur".repeat(400)}`;
writeFileSync(windowFile, instants.map((time, index) =>
  claudeRecord(index % 2 ? "assistant" : "user", new Date(time).toISOString(), index === instants.length - 1 ? long : `window ${index} ${NEEDLE}`)).join(""));

// A fake agentsview whose daemon answers, newest first, with every message that contains the query.
const hitsFor = (query: string) => [[claudeId, claudeFile], [windowId, windowFile]].flatMap(([id, file]) =>
  transcriptMessages(file, "claude", { includeTools: true })
    .filter((message: { fullText: string }) => message.fullText.toLowerCase().includes(query.toLowerCase()))
    .map((message: { role: string; timestamp: string }) => ({ session_id: id, agent: "claude", role: message.role, timestamp: message.timestamp, snippet: query })))
  .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ matches: hitsFor(url.searchParams.get("pattern") ?? ""), next_cursor: 0 }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const bin = join(bins, "running");
mkdirSync(bin);
symlinkSync(rg, join(bin, "rg"));
writeFileSync(join(bin, "agentsview"), `#!/bin/sh\necho "agentsview running at http://127.0.0.1:${(server.address() as AddressInfo).port}"\n`);
chmodSync(join(bin, "agentsview"), 0o755);
const env = { ...process.env, HOME: home, OO_HOME: ooHome, PATH: `${bin}:/usr/bin:/bin` };

const exec = (script: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(process.execPath, [script, ...args], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(`${args.join(" ")}: ${stderr}`)) : resolve(stdout));
});
type Match = { id: string; index: number; match: { text: string } };
const search = async (backend: string, args: string[]) => {
  const output = JSON.parse(await exec(WRAPPER, ["--query", NEEDLE, "--backend", backend, "--json", ...args]));
  assert.equal(output.backend.name, backend);
  return output.matches as Match[];
};

try {
  const sourcesFile = join(bins, "sources.json");
  writeFileSync(sourcesFile, JSON.stringify([
    { type: "claude", root: join(home, ".claude", "projects") },
    { type: "codex", root: join(home, ".codex", "sessions") },
    { type: "pi", root: join(ooHome, "sessions") },
  ]));
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  // The primitive names a Pi session by its whole filename stem.
  for (const [id, file, type] of [[claudeId, claudeFile, "claude"], [codexId, codexFile, "codex"], [`2026-10-04T10-00-00-000Z_${piId}`, piFile, "pi"]]) {
    for (const includeTools of [false, true]) {
      const skim = await exec(PRIMITIVE, ["--sources-file", sourcesFile, "--skim", id, "--max-chars", "100000", ...(includeTools ? ["--include-tools"] : [])]);
      const primitive = skim.split("\n").slice(1).filter(Boolean).map((row) => {
        const [, index, role, text] = /^\[(\d+)\] (\S+)(?: \S+)?: (.*)$/.exec(row)!;
        return `[${index}] ${role}: ${text}`;
      });
      const ours = transcriptMessages(file, type, { includeTools })
        .filter((message: { text: string | null }) => message.text)
        .map((message: { index: number; role: string; text: string }) => `[${message.index}] ${message.role}: ${flat(message.text)}`);
      assert.deepEqual(ours, primitive,
        `${type} ${includeTools ? "with" : "without"} tools: transcriptMessages numbers and reduces messages as session-grep's messagesFrom does`);
    }
  }

  const located = (matches: Match[]) => matches.filter((match) => match.id === windowId).map((match) => match.index).sort((a, b) => a - b);
  for (const window of [["--since", "2026-10-10"], ["--until", "2026-10-10"], ["--since", "2026-10-10", "--until", "2026-10-10"],
    ["--since", "2d"], ["--until", "2d"], ["--since", "today"], ["--until", "today"]]) {
    // A budget wide enough that neither backend omits a match.
    const args = [...window, "--limit", "50", "--max-chars", "100000"];
    assert.deepEqual(located(await search("agentsview", args)), located(await search("session-grep", args)),
      `${window.join(" ")}: both backends read the window as session-grep's parseSince/parseUntil do`);
  }

  // The window holds exactly --limit matches, so both engines budget for the same number of
  // competing hits (the session-grep path otherwise over-fetches). The probe is the newest
  // message, so it has context before it and none after.
  for (const context of [["--before", "0", "--after", "0"], ["--before", "1", "--after", "1"]]) {
    const args = ["--since", "2d", "--limit", "3", ...context];
    const size = async (backend: string) => Buffer.byteLength((await search(backend, [...args, "--max-chars", "12000"]))
      .find((match) => match.id === windowId && match.index === instants.length - 1)!.match.text);
    const [ours, primitive] = [await size("agentsview"), await size("session-grep")];
    // The two engines cut around the match differently, so their sizes may differ by the
    // ellipses and a split character, never by a budget step.
    assert.ok(Math.abs(ours - primitive) <= 8,
      `${args.join(" ")}: a long match previews at ${ours} bytes on agentsview and ${primitive} on session-grep; previewChars must follow matchPreviewChars`);
  }
  process.stdout.write("ok — agentsview backend copies of session-grep rules agree with the vendored primitive\n");
} finally {
  server.close();
  for (const dir of [home, ooHome, bins]) rmSync(dir, { recursive: true, force: true });
}
