import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tempOoHome } from "../gateway/test/helpers";
import { runTranscriptScan, sampleTranscript } from "./scan";

const { dir, cleanup } = tempOoHome("oo-old-sampling");
const originalHome = process.env.HOME;
process.env.HOME = dir;
try {
  const root = join(dir, "cursor");
  const transcripts = join(root, "demo", "agent-transcripts");
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(dir, "session_sources.json"), JSON.stringify({ add: [{ source: "cursor", root }] }));
  const file = join(transcripts, "older-session.jsonl");
  writeFileSync(file, [
    { role: "user", message: { content: [{ type: "text", text: "Implement the historical export" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Export waits for the retention decision" }] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const old = new Date(Date.now() - 45 * 86_400_000);
  utimesSync(file, old, old);
  assert.equal((await runTranscriptScan(["--since", "1d"])).threads.length, 0);
  const admitted = await runTranscriptScan(["--since", "60d"]);
  assert.equal(admitted.threads.length, 1, "longer configured windows admit old transcripts");
  const id = String(admitted.threads[0].id);
  assert.match(await sampleTranscript(id, "cursor"), /retention decision/,
    "an eligible exact session remains sampleable beyond 30 days");
  assert.equal((await runTranscriptScan(["--since", "1d"])).threads.length, 0, "sampling does not widen admission");
  await assert.rejects(sampleTranscript("older", "cursor"), /expected one authorized transcript/, "sampling requires an exact id");
  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: [], repos: [admitted.threads[0].repo] }));
  await assert.rejects(sampleTranscript(id, "cursor"), /expected one authorized transcript/, "sampling rechecks privacy");
  console.log("ok - exact old-session sampling preserves admission windows and privacy");
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  cleanup();
}
