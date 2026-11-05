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
  console.log("ok - Need You sampling takes each side's last two messages from the whole conversation");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  cleanup();
}
