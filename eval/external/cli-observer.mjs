// The instrumented `oo` an external trial puts first on PATH (eval/external/trial.mjs). It plants
// a caller transcript under the agent's real session id, forwards to the measured checkout's CLI
// with the sandbox env, and records each call's arguments, caller identity, exit, and output.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CALLER_MARKER = "Cobalt DNS cache";
const settings = JSON.parse(readFileSync(new URL("./connection.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const actualCaller = process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID;
let explicit;
for (let index = 0; index < args.length; index++) {
  if (settings.valueFlags.includes(args[index])) { index++; continue; }
  if (args[index] === "--from-session") explicit = args[++index];
  else if (args[0] !== "search" && args[index].startsWith("--from-session=")) explicit = args[index].slice(15);
}
const effectiveCaller = explicit?.trim() || (args[0] === "search" ? process.env.OO_CALLER_SESSION_ID?.trim() : undefined)
  || process.env.OO_FROM_SESSION?.trim() || actualCaller?.trim() || null;
// The caller's own transcript matches the 429 question; caller-identity exclusion must keep
// it out of search results.
if (actualCaller && /^[a-zA-Z0-9-]+$/.test(actualCaller)) {
  const file = join(settings.transcripts, `${actualCaller}.jsonl`);
  if (!existsSync(file)) {
    const timestamp = new Date().toISOString();
    const lines = [
      { type: "session_meta", timestamp, payload: { id: actualCaller, cwd: process.cwd(), originator: "codex_cli" } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [
        { type: "input_text", text: `quasar-api spurious 429s: my unverified guess is ${CALLER_MARKER} poisoning. RateLimiter.refill may be unrelated.` },
      ] } },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
}
const result = spawnSync(process.execPath, ["--import", settings.loader, settings.cli, ...args], {
  env: { ...process.env, ...settings.env, OO_AGENT: "1" }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
});
const output = result.stdout ?? "";
appendFileSync(settings.calls, `${JSON.stringify({
  args, actualCaller, effectiveCaller, exitCode: result.status,
  output, stderr: result.stderr ?? "", error: result.error?.message,
  callerTranscriptReturned: output.includes(CALLER_MARKER),
})}\n`);
process.stdout.write(output);
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
