import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempOoHome } from "../gateway/test/helpers";
import { runTranscriptScan, sampleTurns } from "./scan";

const { dir, cleanup } = tempOoHome("oo-needs-you-sampling");
const originalHome = process.env.HOME;
process.env.HOME = dir;
try {
  const root = join(dir, "cursor");
  const transcripts = join(root, "demo", "agent-transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ add: [{ source: "cursor", root }] }));
  const say = (role: "user" | "assistant", text: string) => ({ role, message: { content: [{ type: "text", text }] } });
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => [say("user", `old request ${i + 1}`), say("assistant", `reply ${i + 1}`)]).flat(),
    say("user", "current request"),
    ...Array.from({ length: 42 }, (_, i) => say("assistant", `progress ${i + 1}`)),
    say("user", "<system-reminder>injected context</system-reminder>"),
  ];
  writeFileSync(join(transcripts, "long-turn.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  const id = String((await runTranscriptScan(["--since", "1d"])).threads[0].id);

  assert.deepEqual(await sampleTurns(id), [
    { role: "owner", text: "old request 25" },
    { role: "owner", text: "current request" },
    { role: "agent", text: "progress 41" },
    { role: "agent", text: "progress 42" },
  ], "a long agent turn keeps the owner's latest request, and injected text is not the owner's");

  // The Claude desktop app shows a turn's closing question in a next-step box, which the transcript
  // records only as the wrap_up tool call's input.
  const project = join(dir, ".claude", "projects", "-demo");
  mkdirSync(project, { recursive: true });
  const sessionId = "11111111-2222-4333-8444-555555555555";
  const record = (type: "user" | "assistant", content: unknown[], second: number, stop?: string) => ({
    type, sessionId, cwd: "/demo", timestamp: `2026-11-06T17:25:${String(second).padStart(2, "0")}.000Z`,
    message: { role: type, content, ...(stop ? { stop_reason: stop } : {}) },
  });
  writeFileSync(join(project, `${sessionId}.jsonl`), [
    record("user", [{ type: "text", text: "Why is this readme so big?" }], 1),
    record("assistant", [{ type: "text", text: "Measured the port against upstream." }], 2, "end_turn"),
    record("assistant", [{ type: "tool_use", id: "t1", name: "mcp__ccd_turn__wrap_up", input: {
      recap: "The port carries hand edits in 57 files.",
      ask: "Should I cut the port to the scripted rewrites plus one shim file?",
      actions: [{ label: "Yes, cut to shim" }],
    } }], 3, "tool_use"),
    record("user", [{ type: "tool_result", tool_use_id: "t1", content: "Shown in the next-step box." }], 4),
    record("assistant", [{ type: "text", text: "My recommendation: keep the scripted rewrites and drop the hand edits." }], 5, "end_turn"),
  ].map((row) => JSON.stringify(row)).join("\n"));
  const claudeScan = await runTranscriptScan(["--since", "1970-01-01"]);
  const claude = claudeScan.threads.find((thread) => thread.id === sessionId);
  assert.ok(claude, "the Claude session is scanned");
  assert.equal(claude.working, false, "a turn that ended after the next-step box is not working");
  assert.deepEqual((await sampleTurns(sessionId)).filter((turn) => turn.role === "agent").map((turn) => turn.text), [
    "The port carries hand edits in 57 files. Should I cut the port to the scripted rewrites plus one shim file?",
    "My recommendation: keep the scripted rewrites and drop the hand edits.",
  ], "the question asked in the next-step box is part of the agent's turn");
  console.log("ok - Need You sampling takes each side's last two messages from the whole conversation");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  cleanup();
}
