import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempOoHome } from "../gateway/test/helpers";
import { sampleTurns } from "./scan";

const { dir, cleanup } = tempOoHome("oo-needs-you-budget");
const originalHome = process.env.HOME;
process.env.HOME = dir;
const project = join(dir, ".claude", "projects", "-demo");
const budget = 24_000;
type ClassifierTurn = Awaited<ReturnType<typeof sampleTurns>>[number];
type TranscriptTurn = ClassifierTurn | { role: "tool"; text: string };
const owner = (text: string): ClassifierTurn => ({ role: "owner", text });
const agent = (text: string): ClassifierTurn => ({ role: "agent", text });
const tool = (text: string): TranscriptTurn => ({ role: "tool", text });
const toolTurn = (text: string) => agent(`[tool result] ${text}`);
const interrupt = owner("[Request interrupted by user]");
const interrupted = owner("[Turn ended: the owner interrupted it.]");

function writeSession(id: string, turns: TranscriptTurn[]) {
  const file = join(project, `${id}.jsonl`);
  for (const turn of turns) {
    const role = turn.role === "agent" ? "assistant" : "user";
    const content = turn.role === "tool"
      ? { type: "tool_result", content: turn.text }
      : { type: "text", text: turn.text };
    appendFileSync(file, JSON.stringify({
      type: role, sessionId: id, entrypoint: "cli", cwd: dir, timestamp: "2026-11-24T17:00:00.000Z",
      message: { role, content: [content], ...(role === "assistant" ? { stop_reason: "end_turn" } : {}) },
    }) + "\n");
  }
}

function textLength(turns: ClassifierTurn[]) {
  return turns.reduce((sum, turn) => sum + turn.text.length, 0);
}

try {
  mkdirSync(project, { recursive: true });
  await test("counts the tool prefix against 24,000 characters of raw text", async () => {
    const id = "10000000-1111-4111-8111-000000000001";
    const authored = [owner("Check."), agent("Running."), agent("Done.")];
    const result = tool("x".repeat(budget - textLength(authored)));
    writeSession(id, [authored[0], authored[1], result, authored[2]]);

    const turns = await sampleTurns(id);
    const length = textLength(turns);
    assert.ok(length <= budget, `Expected at most ${budget} formatted characters, received ${length}`);
    assert.deepEqual(turns, authored);
  });

  await test("samples a session with 65 MiB of tool results", async () => {
    const id = "10000000-1111-4111-8111-000000000002";
    const authored = [owner("Check."), agent("Running."), agent("Done.")];
    const result = tool("x".repeat(1024 * 1024));
    writeSession(id, [authored[0], authored[1], ...Array(65).fill(result), authored[2]]);

    assert.deepEqual(await sampleTurns(id), authored);
  });

  await test("keeps a tool result at the exact limit including the synthetic turn end", async () => {
    const id = "10000000-1111-4111-8111-000000000003";
    const request = owner("Check.");
    const reply = agent("Running.");
    const available = budget - textLength([request, reply, interrupt, interrupted, toolTurn("")]);
    const fits = "x".repeat(available);
    writeSession(id, [request, reply, tool(fits), interrupt]);
    assert.deepEqual(await sampleTurns(id), [request, reply, toolTurn(fits), interrupt, interrupted]);

    const overId = "10000000-1111-4111-8111-000000000004";
    writeSession(overId, [request, reply, tool("x".repeat(available + 1)), interrupt]);
    const turns = await sampleTurns(overId);
    const length = textLength(turns);
    assert.ok(length <= budget, `Expected at most ${budget} formatted characters, received ${length}`);
    assert.deepEqual(turns, [request, reply, interrupt, interrupted]);
  });

  await test("keeps the newest fitting results in transcript order across thousands of small results", async () => {
    const id = "10000000-1111-4111-8111-000000000005";
    const request = owner("Check.");
    const reply = agent("Done.");
    const results = Array.from({ length: 3_000 }, (_, index) => String(index).padStart(4, "0"));
    writeSession(id, [request, ...results.map(tool), reply]);

    const turns = await sampleTurns(id);
    const length = textLength(turns);
    assert.ok(length <= budget, `Expected at most ${budget} formatted characters, received ${length}`);
    const kept = Math.floor((budget - textLength([request, reply])) / toolTurn(results[0]).text.length);
    assert.deepEqual(turns, [request, ...results.slice(-kept).map(toolTurn), reply]);
  });

  await test("clips oversized authored turns and preserves the request, reply, and interrupt evidence", async () => {
    const id = "10000000-1111-4111-8111-000000000006";
    const request = owner("Check the build.");
    const reply = agent("The build passed.");
    writeSession(id, [
      owner(`Old request: ${"x".repeat(65 * 1024 * 1024)}`), agent(`Old reply: ${"y".repeat(40_000)}`),
      request, reply, interrupt,
    ]);

    const turns = await sampleTurns(id);
    const length = textLength(turns);
    assert.ok(length <= budget, `Expected at most ${budget} formatted characters, received ${length}`);
    assert.equal(turns.length, 6);
    assert.equal(turns[0].role, "owner");
    assert.match(turns[0].text, /^Old request: /);
    assert.equal(turns[1].role, "agent");
    assert.match(turns[1].text, /^Old reply: /);
    assert.deepEqual(turns.slice(2), [request, reply, interrupt, interrupted]);
  });
} finally {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  cleanup();
}
