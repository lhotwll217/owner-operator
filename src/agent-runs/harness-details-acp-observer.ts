import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  AGENT_RUN_CAPABILITIES,
  AgentRunHarness,
  type AgentRunEffort,
} from "@owner-operator/core";
import { createAgentRegistry, type AcpRuntimeStatus } from "acpx/runtime";
import { ownerOperatorHome } from "../shared/paths";
import { configOptionsFromStatus } from "./acp-session-selection";
import {
  agentRunStateDir,
  createLeasedAcpRuntime,
  cursorAgentBinaryPath,
  type LeasedAcpRuntime,
} from "./acp-launcher";

const OBSERVATION_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 2_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_VERSION_BYTES = 64 * 1024;

export interface AcpRuntimeProvenance {
  acpxVersion: string;
  adapter: {
    packageName: string | null;
    packageVersion: string | null;
    resolution: "package-lock" | "path";
  };
  backend: {
    name: string;
    version: string | null;
    source: "adapter-dependency" | "path-command";
  };
}

export interface HarnessCapabilityObservation {
  harness: AgentRunHarness;
  acpxAgent: string;
  observedAt: string;
  runtime: AcpRuntimeProvenance | null;
  requestedInspection: { model: string; effort: AgentRunEffort | null } | null;
  session: {
    models: {
      currentModelId?: string;
      availableModelIds: string[];
    } | null;
    configOptions: SessionConfigOption[] | null;
    usage: unknown | null;
  } | null;
  confirmation: { model: string; effort?: AgentRunEffort } | null;
  error: string | null;
}

export interface AcpRegistryProvenance {
  acpxVersion: string;
  registeredAgentNames: string[];
}

export interface AcpObservationDeps {
  createRuntime?: (params: {
    harness: AgentRunHarness;
    leaseKey: string;
    stateDir: string;
  }) => LeasedAcpRuntime;
  readRuntimeProvenance?: (harness: AgentRunHarness) => Promise<AcpRuntimeProvenance>;
  timeoutMs?: number;
  closeTimeoutMs?: number;
  probeStateDir?: string;
  now?: () => Date;
}

/** Read package metadata from the exact installed runtime used by the launcher. */
export function readAcpRegistryProvenance(): AcpRegistryProvenance {
  return {
    acpxVersion: packageVersion(packageJsonPath("acpx/package.json")),
    registeredAgentNames: createAgentRegistry().list(),
  };
}

/** Resolve adapter and backend provenance from the same installed packages/path command selected
 * by createLeasedAcpRuntime. A row is not allowed to claim session facts if this lookup fails. */
export async function readAcpRuntimeProvenance(
  harness: AgentRunHarness,
  deps: {
    resolveCursorCommand?: () => string;
    readCommandVersion?: (command: string) => Promise<string>;
  } = {},
): Promise<AcpRuntimeProvenance> {
  const acpxVersion = packageVersion(packageJsonPath("acpx/package.json"));
  if (harness === AgentRunHarness.Cursor) {
    const command = (deps.resolveCursorCommand ?? cursorAgentBinaryPath)();
    return {
      acpxVersion,
      adapter: { packageName: null, packageVersion: null, resolution: "path" },
      backend: {
        name: "cursor-agent",
        version: await (deps.readCommandVersion ?? readCommandVersion)(command),
        source: "path-command",
      },
    };
  }

  const adapterName = harness === AgentRunHarness.ClaudeCode
    ? "@agentclientprotocol/claude-agent-acp"
    : "@agentclientprotocol/codex-acp";
  const backendName = harness === AgentRunHarness.ClaudeCode
    ? "@anthropic-ai/claude-agent-sdk"
    : "@openai/codex";
  const adapterPackagePath = packageJsonPath(`${adapterName}/package.json`);
  const adapterRequire = createRequire(adapterPackagePath);
  const backendPackagePath = resolvedPackageJson(adapterRequire, backendName);
  return {
    acpxVersion,
    adapter: {
      packageName: adapterName,
      packageVersion: packageVersion(adapterPackagePath),
      resolution: "package-lock",
    },
    backend: {
      name: backendName,
      version: packageVersion(backendPackagePath),
      source: "adapter-dependency",
    },
  };
}

/** Observe one harness through the exact disposable ACP launch seam used by delegated sessions.
 * All failures are returned on this row after cleanup; callers can safely observe rows in parallel. */
export async function observeAcpHarness(
  harness: AgentRunHarness,
  deps: AcpObservationDeps = {},
): Promise<HarnessCapabilityObservation> {
  const observedAt = (deps.now?.() ?? new Date()).toISOString();
  const acpxAgent = AGENT_RUN_CAPABILITIES[harness].acpAgent;
  const base = (): HarnessCapabilityObservation => ({
    harness,
    acpxAgent,
    observedAt,
    runtime: null,
    requestedInspection: null,
    session: null,
    confirmation: null,
    error: null,
  });

  let provenance: AcpRuntimeProvenance;
  try {
    provenance = await (deps.readRuntimeProvenance ?? readAcpRuntimeProvenance)(harness);
  } catch (error) {
    return { ...base(), error: `runtime provenance: ${messageOf(error)}` };
  }

  const probeKey = `harness-details-${randomUUID()}`;
  const probeStateDir = deps.probeStateDir ?? join(agentRunStateDir(), "probes", probeKey);
  let leased: LeasedAcpRuntime | undefined;
  let session: ReturnType<LeasedAcpRuntime["runtime"]["ensureSession"]> | undefined;
  let handle: Awaited<ReturnType<LeasedAcpRuntime["runtime"]["ensureSession"]>> | undefined;
  let observation: HarnessCapabilityObservation;
  try {
    leased = (deps.createRuntime ?? createLeasedAcpRuntime)({ harness, leaseKey: probeKey, stateDir: probeStateDir });
    session = leased.runtime.ensureSession({
      sessionKey: probeKey,
      agent: acpxAgent,
      mode: "oneshot",
      cwd: ownerOperatorHome(),
    });
    handle = await withDeadline(
      session,
      deps.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
      `${harness} ACP observation timed out during initialization`,
    );
    if (!leased.runtime.getStatus) throw new Error("ACP runtime does not expose session status");
    const status = await withDeadline(
      leased.runtime.getStatus({ handle }),
      deps.timeoutMs ?? OBSERVATION_TIMEOUT_MS,
      `${harness} ACP observation timed out while reading status`,
    );
    const configOptions = configOptionsFromStatus(status);
    observation = {
      ...base(),
      runtime: provenance,
      session: sessionFromStatus(status, configOptions),
    };
  } catch (error) {
    observation = { ...base(), runtime: provenance, error: messageOf(error) };
  } finally {
    if (session) void session.catch(() => undefined);
    if (leased) {
      try {
        await discardObservation(
          leased,
          handle,
          probeStateDir,
          deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
        );
      } catch (error) {
        observation = {
          ...observation!,
          error: appendError(observation!.error, `cleanup: ${messageOf(error)}`),
        };
      }
    }
  }
  return observation!;
}

function sessionFromStatus(
  status: AcpRuntimeStatus,
  configOptions: SessionConfigOption[] | null,
): NonNullable<HarnessCapabilityObservation["session"]> {
  return {
    models: status.models
      ? {
          ...(status.models.currentModelId !== undefined
            ? { currentModelId: status.models.currentModelId }
            : {}),
          availableModelIds: status.models.availableModelIds,
        }
      : null,
    configOptions,
    usage: status.usage ?? null,
  };
}

async function discardObservation(
  leased: LeasedAcpRuntime,
  handle: Awaited<ReturnType<LeasedAcpRuntime["runtime"]["ensureSession"]>> | undefined,
  stateDir: string,
  closeTimeoutMs: number,
): Promise<void> {
  let trackedPids: number[] | null = null;
  if (handle) {
    try {
      trackedPids = await leased.processTreePids();
    } catch {
      // Termination can still rediscover the wrapper directly from its lease identity.
    }
    const close = Promise.resolve().then(() => leased.runtime.close({
      handle,
      reason: "harness capability observation finished",
      discardPersistentState: true,
    }));
    try {
      await withDeadline(close, closeTimeoutMs, "ACP observation graceful close timed out");
    } catch {
      // Graceful close is best-effort. The durable lease termination below remains authoritative.
    } finally {
      void close.catch(() => undefined);
    }
  }
  const terminated = await leased.terminate(trackedPids ?? undefined);
  if (!terminated) {
    throw new Error("ACP observation process cleanup could not be confirmed; lease and store retained");
  }
  leased.release();
  rmSync(stateDir, { recursive: true, force: true });
}

function packageJsonPath(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}

function packageVersion(path: string): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error(`package metadata has no version: ${path}`);
  }
  return value.version;
}

function resolvedPackageJson(require: NodeJS.Require, packageName: string): string {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (errorCode(error) !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let directory = dirname(require.resolve(packageName));
  for (;;) {
    const candidate = join(directory, "package.json");
    try {
      const value = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
      if (value.name === packageName) return candidate;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`could not resolve package metadata for ${packageName}`);
    directory = parent;
  }
}

function readCommandVersion(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ["--version"],
      { timeout: VERSION_TIMEOUT_MS, maxBuffer: MAX_VERSION_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else {
          const version = stdout.trim();
          if (!version) reject(new Error(`${command} --version returned no version`));
          else resolve(version);
        }
      },
    );
  });
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendError(current: string | null, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
