import { join } from "node:path";
import { createAcpRuntime, createRuntimeStore, createAgentRegistry, type AcpRuntime } from "acpx/runtime";
import {
  AGENT_RUN_CAPABILITIES,
  AgentRunStatus,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type ChildIdentity,
} from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import type { AgentRunLauncher } from "./executor";

/** Cap on the in-memory result buffer the launcher retains while a turn streams. The executor
 * persists only a smaller tail (RESULT_TAIL_BYTES, 32KB), so this bounds daemon memory against a
 * verbose child while still covering everything that gets persisted. */
const MAX_BUFFERED_RESULT_BYTES = 64 * 1024;

/** Where acpx persists its per-child session records. Relocated out of the system tmpdir
 * (acpx's default) into OO_HOME per the issue #69 hardening note, so restart reconciliation
 * and resume can find child identities across daemon restarts. */
export function agentRunStateDir(): string {
  return join(ownerOperatorHome(), "agent-runs");
}

export interface AcpLauncherOptions {
  /** Injectable for tests; production builds the real acpx runtime. */
  runtimeFactory?: () => AcpRuntime;
}

/** Bridges the executor's launcher seam to acpx: one child ACP session per run, the child's
 * event stream mirrored into the ledger as explicit activity, and the protocol turn result
 * mapped to a terminal run status. Permissions stay in-harness and non-escalating: OO forces
 * `nonInteractivePermissions: "fail"`, so a headless child that hits an unapprovable ask fails
 * loudly into the run row rather than silently degrading. */
export function createAcpLauncher(options: AcpLauncherOptions = {}): AgentRunLauncher {
  const runtime = options.runtimeFactory
    ? options.runtimeFactory()
    : createAcpRuntime({
        cwd: ownerOperatorHome(),
        sessionStore: createRuntimeStore({ stateDir: agentRunStateDir() }),
        agentRegistry: createAgentRegistry(),
        // Per the issue #69 decision record: deny-by-default for non-read asks — reads pass, any
        // change ask the child's own harness config didn't already approve does not. The owner's
        // harness settings remain the real gate; OO never loosens this and never escalates.
        permissionMode: "approve-reads",
        // Fail-closed: an unapprovable ask fails the turn (recorded as a run failure) rather
        // than continuing degraded. Owner decision on issue #69.
        nonInteractivePermissions: "fail",
      });

  return async (request: AgentRunLaunchRequest): Promise<AgentRunLaunchResult> => {
    const capability = AGENT_RUN_CAPABILITIES[request.run.harness];
    if (!capability) throw new Error(`unknown delegation harness: ${request.run.harness}`);

    const handle = await runtime.ensureSession({
      sessionKey: request.run.id,
      agent: capability.acpAgent,
      mode: "persistent",
      cwd: request.run.cwd,
      ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
      ...(request.run.model ? { sessionOptions: { model: request.run.model } } : {}),
    });
    request.onActivity(identityOf(handle));

    // OO owns the deadline (executor timeout drives the abort signal); acpx must not treat a
    // timeout-after-partial-output as a completed turn, so we pass no launcher-side timeout.
    const turn = runtime.startTurn({
      handle,
      text: request.run.task,
      mode: "prompt",
      requestId: request.run.id,
      signal: request.signal,
    });

    // Bound daemon memory: a verbose child could emit unbounded output, but only a tail is ever
    // persisted (the executor truncates to RESULT_TAIL_BYTES). Keep a rolling byte-bounded window
    // of the newest chunks — sized to cover that persisted tail — evicting the oldest.
    const chunks: string[] = [];
    let bufferedBytes = 0;
    for await (const event of turn.events) {
      if (request.signal.aborted) break;
      if (event.type === "text_delta" && event.stream !== "thought") {
        chunks.push(event.text);
        bufferedBytes += Buffer.byteLength(event.text);
        while (chunks.length > 1 && bufferedBytes > MAX_BUFFERED_RESULT_BYTES) {
          const removed = chunks.shift();
          if (removed !== undefined) bufferedBytes -= Buffer.byteLength(removed);
        }
        if (bufferedBytes > MAX_BUFFERED_RESULT_BYTES) {
          chunks[0] = utf8Tail(chunks[0], MAX_BUFFERED_RESULT_BYTES);
          bufferedBytes = Buffer.byteLength(chunks[0]);
        }
        request.onActivity({ activity: previewOf(event.text) });
      } else if (event.type === "status" && event.text) {
        request.onActivity({ activity: previewOf(event.text) });
      } else if (event.type === "tool_call" && (event.title || event.text)) {
        request.onActivity({ activity: previewOf(event.title ?? event.text) });
      }
    }

    const result = await turn.result;
    const identity = identityOf(handle);
    if (result.status === "completed") {
      return { status: AgentRunStatus.Completed, resultText: chunks.join(""), error: null, ...identity };
    }
    if (result.status === "cancelled") {
      return { status: AgentRunStatus.Cancelled, resultText: chunks.join(""), error: result.stopReason ?? "cancelled", ...identity };
    }
    return {
      status: AgentRunStatus.Failed,
      resultText: chunks.join(""),
      error: result.error.message,
      ...identity,
    };
  };
}

/** The child identity carried on a run row: the harness's own session id (resume + monitor
 * join key) and the acpx record id (reconciliation). Absent fields are omitted, not nulled. */
function identityOf(handle: { agentSessionId?: string; acpxRecordId?: string }): ChildIdentity {
  return {
    ...(handle.agentSessionId ? { childSessionId: handle.agentSessionId } : {}),
    ...(handle.acpxRecordId ? { acpxRecordId: handle.acpxRecordId } : {}),
  };
}

function previewOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString();
}
