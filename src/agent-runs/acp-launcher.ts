import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAcpRuntime,
  createRuntimeStore,
  createAgentRegistry,
  type AcpRuntime,
  type AcpSessionStore,
} from "acpx/runtime";
import {
  AGENT_RUN_CAPABILITIES,
  AgentRunStatus,
  harnessIdentityObservation,
  isAgentRunEffort,
  type AgentRunHarness,
  type AgentRunLaunchRequest,
  type AgentRunLaunchResult,
  type ChildIdentity,
} from "@owner-operator/core";
import { ownerOperatorHome } from "../shared/paths";
import type { AgentRunLauncher } from "./executor";
import {
  closeAgentRunProcessLease,
  createAgentRunProcessLease,
  agentRunProcessTreePids,
  reapStaleAgentRunProcesses,
  terminateAgentRunProcessLease,
  updateAgentRunProcessLease,
} from "./process-lease";

/** Cap on the in-memory result buffer the launcher retains while a turn streams. The executor
 * persists only a smaller tail (RESULT_TAIL_BYTES, 32KB), so this bounds daemon memory against a
 * verbose child while still covering everything that gets persisted. */
const MAX_BUFFERED_RESULT_BYTES = 64 * 1024;
const REASONING_EFFORT_CONFIG_OPTION = "reasoning_effort";
const CHILD_TASK_BOUNDARY =
  "Do the work yourself. Do not launch nested or background agents; delegated children must complete the task directly.";

/** Preserve the durable owner task verbatim while adding execution-only child policy. */
export function delegatedChildTaskEnvelope(task: string): string {
  return `${task}\n\n${CHILD_TASK_BOUNDARY}`;
}

/** Where acpx persists its per-child session records. Relocated out of the system tmpdir
 * (acpx's default) into OO_HOME per the issue #69 hardening note, so restart reconciliation
 * and resume can find child identities across daemon restarts. */
export function agentRunStateDir(): string {
  return join(ownerOperatorHome(), "agent-runs");
}

export interface AcpLauncherOptions {
  /** Injectable for tests; production builds the real acpx runtime. */
  runtimeFactory?: () => AcpRuntime;
  /** Injectable leased runtime for deterministic lifecycle tests. */
  leasedRuntimeFactory?: typeof createLeasedAcpRuntime;
}

/** The exact wrapper entrypoint every OO-spawned ACP child runs under. Startup cleanup matches on
 * this path, so discovery and delegated runs must resolve it the same way. */
export function agentRunWrapperPath(): string {
  return fileURLToPath(new URL("./acp-process-wrapper.mjs", import.meta.url));
}

export interface LeasedAcpRuntime {
  runtime: AcpRuntime;
  sessionStore: AcpSessionStore;
  leaseId: string;
  /** Drop the durable ownership record once the child process tree is closed. */
  release: () => void;
  /** Terminate an owned wrapper even when initialization never yielded a session handle. */
  terminate: (trackedPids?: readonly number[]) => Promise<boolean>;
  /** Capture descendants before a graceful close can reparent them. */
  processTreePids: () => Promise<number[] | null>;
}

/** Build an acpx runtime whose child process tree is owned by a durable lease before acpx can
 * spawn. Delegated runs and read-only harness observation share this seam so a hard daemon crash
 * always leaves exactly one reapable wrapper identity per spawned child. */
export function createLeasedAcpRuntime(params: {
  harness: AgentRunHarness;
  leaseKey: string;
  /** Defaults to the durable delegated-run store. Read-only probes pass a throwaway directory so
   * observing a harness leaves no session record behind. */
  stateDir?: string;
  /** Injectable for tests; production resolves the harness's real adapter command. */
  resolveAgentCommand?: (acpAgent: string) => string;
}): LeasedAcpRuntime {
  const capability = AGENT_RUN_CAPABILITIES[params.harness];
  if (!capability) throw new Error(`unknown delegation harness: ${params.harness}`);

  const wrapperPath = agentRunWrapperPath();
  // The lease is durable before ensureSession can spawn. The command-line identity plus exact
  // wrapper path lets startup cleanup fail closed after a hard daemon crash.
  const lease = createAgentRunProcessLease({ runId: params.leaseKey, wrapperPath });
  try {
    const agentCommand = (params.resolveAgentCommand ?? defaultAgentCommand)(capability.acpAgent);
    const sessionStore = createRuntimeStore({ stateDir: params.stateDir ?? agentRunStateDir() });
    const runtime = createAcpRuntime({
      cwd: ownerOperatorHome(),
      sessionStore,
      agentRegistry: createAgentRegistry({
        overrides: {
          [capability.acpAgent]: leasedAgentCommand({
            wrapperPath,
            leaseId: lease.leaseId,
            agentCommand,
            acpAgent: capability.acpAgent,
          }),
        },
      }),
      // Owner ruling 2026-07-22 (supersedes the issue #69 fail-closed record): delegated
      // children inherit the child harness's own permission config — the same gate as
      // launching that harness directly. OO adds no extra permission layer.
      permissionMode: "approve-all",
    });

    return {
      runtime,
      sessionStore,
      leaseId: lease.leaseId,
      release: () => closeAgentRunProcessLease(lease.leaseId),
      terminate: (trackedPids) => terminateAgentRunProcessLease({
        leaseId: lease.leaseId,
        wrapperPath,
        trackedPids,
      }),
      processTreePids: () => agentRunProcessTreePids({ leaseId: lease.leaseId, wrapperPath }),
    };
  } catch (error) {
    // Resolving the adapter or building the runtime can fail before anything is spawned, and a
    // lease with no process to own would be reaped by nobody. Roll it back so a failed setup
    // leaves no durable trace.
    closeAgentRunProcessLease(lease.leaseId);
    throw error;
  }
}

function defaultAgentCommand(acpAgent: string): string {
  if (acpAgent === "codex") return codexAcpAgentCommand();
  if (acpAgent === "cursor") return cursorAcpAgentCommand();
  return createAgentRegistry().resolve(acpAgent);
}

/** Bridges the executor's launcher seam to acpx: one child ACP session per run, the child's
 * event stream mirrored into the ledger as explicit activity, and the protocol turn result
 * mapped to a terminal run status. Permissions stay in-harness: `permissionMode: "approve-all"`
 * defers every ask to the child harness's own configuration — the same gate as launching that
 * harness directly. OO adds no extra permission layer. */
export function createAcpLauncher(options: AcpLauncherOptions = {}): AgentRunLauncher {
  if (options.runtimeFactory) {
    const runtime = options.runtimeFactory();
    return (request) => runAcpTurn(runtime, request);
  }

  const launcher: AgentRunLauncher = async (
    request: AgentRunLaunchRequest,
  ): Promise<AgentRunLaunchResult> => {
    const leased = (options.leasedRuntimeFactory ?? createLeasedAcpRuntime)({
      harness: request.run.harness,
      leaseKey: request.run.id,
    });

    let handle: Awaited<ReturnType<AcpRuntime["ensureSession"]>> | undefined;
    try {
      handle = await ensureAcpSession(leased.runtime, request);
      const record = await leased.sessionStore.load(handle.acpxRecordId ?? request.run.id);
      if (record?.pid) {
        updateAgentRunProcessLease(leased.leaseId, {
          rootPid: record.pid,
          rootCommand: record.agentCommand,
        });
      }
      return await runAcpTurn(leased.runtime, request, handle);
    } finally {
      if (handle) {
        try {
          const trackedPids = await leased.processTreePids();
          await leased.runtime.close({ handle, reason: "delegated run finished" });
          if (trackedPids !== null) {
            await leased.terminate(trackedPids);
          }
        } catch {
          // Keep the lease: startup cleanup can reap a wrapper that resisted normal close.
        }
      } else {
        // acpx closes a partially initialized client in ensureSession's own finally block.
        await leased.terminate();
      }
    }
  };
  launcher.reapOrphans = async () => {
    await reapStaleAgentRunProcesses({ wrapperPath: agentRunWrapperPath() });
  };
  return launcher;
}

async function runAcpTurn(
  runtime: AcpRuntime,
  request: AgentRunLaunchRequest,
  existingHandle?: Awaited<ReturnType<AcpRuntime["ensureSession"]>>,
): Promise<AgentRunLaunchResult> {
  const handle = existingHandle ?? await ensureAcpSession(runtime, request);
  request.onActivity(identityOf(handle));
  await applyAdvertisedEffort(runtime, handle, request);
  await observeHarnessIdentity(runtime, handle, request);

  // OO owns the deadline (executor timeout drives the abort signal); acpx must not treat a
  // timeout-after-partial-output as a completed turn, so we pass no launcher-side timeout.
  const turn = runtime.startTurn({
    handle,
    text: delegatedChildTaskEnvelope(request.run.task),
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
}

/** Apply effort only through ACP's self-described config-option control. An absent option is an
 * honest no-op: the durable row retains the requested effort with effortApplied=false. */
async function applyAdvertisedEffort(
  runtime: AcpRuntime,
  handle: Awaited<ReturnType<AcpRuntime["ensureSession"]>>,
  request: AgentRunLaunchRequest,
): Promise<void> {
  if (!request.run.effort || !runtime.getCapabilities || !runtime.setConfigOption) return;
  const capabilities = await runtime.getCapabilities({ handle });
  if (!capabilities.configOptionKeys?.includes(REASONING_EFFORT_CONFIG_OPTION)) return;
  await runtime.setConfigOption({
    handle,
    key: REASONING_EFFORT_CONFIG_OPTION,
    value: request.run.effort,
  });
  request.onActivity({ effortApplied: true });
}

/** Read back the session's effective identity after configuration. This is deliberately separate
 * from the persisted launch request, giving status clients live harness evidence. */
async function observeHarnessIdentity(
  runtime: AcpRuntime,
  handle: Awaited<ReturnType<AcpRuntime["ensureSession"]>>,
  request: AgentRunLaunchRequest,
): Promise<void> {
  if (!runtime.getStatus) return;
  let status: Awaited<ReturnType<NonNullable<AcpRuntime["getStatus"]>>>;
  try {
    status = await runtime.getStatus({ handle });
  } catch {
    // Observation is audit evidence, not a new launch gate. The live proof requires the evidence;
    // ordinary delegated turns continue if an adapter cannot expose status after configuration.
    return;
  }
  const harnessModel = status.models?.currentModelId;
  const configOptions = status.details?.configOptions;
  const effortOption = Array.isArray(configOptions)
    ? configOptions.find((option) => option && typeof option === "object" && "id" in option
      && option.id === REASONING_EFFORT_CONFIG_OPTION)
    : undefined;
  const value = effortOption && "currentValue" in effortOption ? effortOption.currentValue : null;
  const harnessEffort = typeof value === "string" && isAgentRunEffort(value) ? value : undefined;
  request.onActivity({ harnessIdentity: harnessIdentityObservation({ model: harnessModel, effort: harnessEffort }) });
}

function ensureAcpSession(
  runtime: AcpRuntime,
  request: AgentRunLaunchRequest,
): ReturnType<AcpRuntime["ensureSession"]> {
  const capability = AGENT_RUN_CAPABILITIES[request.run.harness];
  if (!capability) throw new Error(`unknown delegation harness: ${request.run.harness}`);
  return runtime.ensureSession({
    sessionKey: request.run.id,
    agent: capability.acpAgent,
    mode: "persistent",
    cwd: request.run.cwd,
    ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(request.run.model ? { sessionOptions: { model: request.run.model } } : {}),
  });
}

/** acpx 0.11's built-in Codex registry is pinned to codex-acp 0.0.44, which cannot
 * initialize current Codex. Resolve Owner Operator's tested direct dependency instead so the
 * package lock, not acpx's stale fallback registry, owns adapter compatibility. */
export function codexAcpAgentCommand(): string {
  const entrypoint = fileURLToPath(import.meta.resolve("@agentclientprotocol/codex-acp"));
  return [JSON.stringify(process.execPath), JSON.stringify(entrypoint)].join(" ");
}

/** Cursor's CLI ships a first-party ACP server (`cursor-agent acp`), so no adapter package sits
 * between Owner Operator and the harness; acpx has no built-in `cursor` registry entry, so the
 * command is supplied through the same override seam Codex uses. */
export function cursorAcpAgentCommand(): string {
  return `${JSON.stringify(cursorAgentBinaryPath())} acp`;
}

/** Resolve the locally installed `cursor-agent` launcher to an absolute path: the daemon's PATH
 * need not include the CLI installer's target directory (`~/.local/bin`). */
export function cursorAgentBinaryPath(): string {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
  ].map((dir) => join(dir, "cursor-agent"));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present or not executable in this directory; keep looking.
    }
  }
  throw new Error("cursor-agent CLI not found on PATH or in ~/.local/bin; install it to delegate to Cursor");
}

function leasedAgentCommand(params: {
  wrapperPath: string;
  leaseId: string;
  agentCommand: string;
  acpAgent: string;
}): string {
  return [
    JSON.stringify(process.execPath),
    JSON.stringify(params.wrapperPath),
    "--oo-agent-run-lease",
    params.leaseId,
    // acpx detects Claude-specific ACP metadata from argv. Preserve that marker while the actual
    // adapter command stays encoded for the wrapper.
    "--oo-agent-kind",
    params.acpAgent === "claude" ? "claude-agent-acp" : params.acpAgent,
    "--oo-agent-command",
    Buffer.from(params.agentCommand, "utf8").toString("base64url"),
  ].join(" ");
}

/** The child identity carried on a run row: prefer the harness-native session id, then the ACP
 * backend session id used for resume when an adapter (currently Claude) exposes no separate
 * native id. The acpx record id remains the reconciliation key. */
function identityOf(handle: {
  agentSessionId?: string;
  backendSessionId?: string;
  acpxRecordId?: string;
}): ChildIdentity {
  const childSessionId = handle.agentSessionId ?? handle.backendSessionId;
  return {
    ...(childSessionId ? { childSessionId } : {}),
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
