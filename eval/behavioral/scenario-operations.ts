import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunHarness, AgentRunStatus } from "@owner-operator/core";

/** OO-specific environment operation reused by every mark-done sample. */
export function materializeMarkDoneScenario({
  root,
  taskCwd,
  parentThreadId,
  childSessionId,
  sentinelSessionId,
  result,
  shouldMarkDone,
  now = new Date().toISOString(),
}: {
  root: string;
  taskCwd: string;
  parentThreadId: string;
  childSessionId: string;
  sentinelSessionId: string;
  result: string;
  shouldMarkDone: boolean;
  now?: string;
}) {
  for (const [name, value] of Object.entries({
    root,
    taskCwd,
    parentThreadId,
    childSessionId,
    sentinelSessionId,
    result,
  })) {
    if (!value.trim()) throw new Error(`${name} is required`);
  }
  if (childSessionId === sentinelSessionId) throw new Error("child and sentinel ids must differ");

  const transcripts = join(root, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  const childTranscript = writeTranscript(
    join(transcripts, `${childSessionId}.jsonl`),
    childSessionId,
    taskCwd,
    "sanitized eval fixture: delegated child worked on the release checklist",
    now,
  );
  const sentinelTranscript = writeTranscript(
    join(transcripts, `${sentinelSessionId}.jsonl`),
    sentinelSessionId,
    taskCwd,
    "sanitized eval fixture: unrelated owner decision remains active",
    now,
  );
  const earlier = new Date(Date.parse(now) - 60_000).toISOString();
  const rows = [
    {
      id: childSessionId,
      source: "codex",
      repo: "sandbox-project",
      app: "Codex CLI",
      topic: "Release checklist implementation",
      transcriptPath: childTranscript,
      state: "working",
      createdAt: earlier,
      lastMessageAt: now,
      working: false,
    },
    {
      id: sentinelSessionId,
      source: "codex",
      repo: "unrelated-project",
      app: "Codex CLI",
      topic: "Unrelated deployment decision",
      transcriptPath: sentinelTranscript,
      state: "needs-you",
      createdAt: earlier,
      lastMessageAt: now,
      working: false,
    },
  ];

  return {
    rows,
    run: {
      create: {
        harness: AgentRunHarness.Codex,
        task: "Update the release checklist and validate it.",
        cwd: taskCwd,
        parentThreadId,
        model: null,
        effort: null,
        depth: 1,
        timeoutSeconds: 300,
        childSessionId,
      },
      outcome: {
        status: AgentRunStatus.Completed,
        resultTail: result,
        error: null,
        childSessionId,
      },
    },
    expected: { childSessionId, sentinelSessionId, shouldMarkDone },
  };
}

function writeTranscript(file: string, id: string, cwd: string, text: string, timestamp: string): string {
  const lines = [
    { timestamp, type: "session_meta", payload: { id, cwd, originator: "codex_cli" } },
    {
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    },
    { timestamp, type: "event_msg", payload: { type: "task_complete" } },
  ];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}
