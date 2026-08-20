import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureOwnerOperatorWorkspace,
  importPiConfiguration,
  markOnboarded,
  ownerOperatorPaths,
  savePermissionMode,
} from "@owner-operator/core";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import {
  createOoSession,
  createOwnerOperatorSession,
  ooProvenance,
  shutdownSessionExtensions,
  type OwnerOperatorSession,
} from "../src/agent/agent";
import { startDaemon, type RunningDaemon } from "../src/daemon/runtime";
import { repoRoot } from "../src/shared/repo-root";
import { absoluteTsxLoaderPath } from "../src/shared/tsx-loader";
import {
  evalSandboxUserPaths,
  sanitizeEvalDiagnosticValue,
  sanitizeEvalSessionTrace,
} from "./sandbox.mjs";

export const SANDBOX_USER_PROFILES = [
  "fresh-onboarding",
  "already-onboarded",
  "deterministic-harness",
  "live-harness",
  "cli-driving",
] as const;

export type SandboxUserProfile = typeof SANDBOX_USER_PROFILES[number];

interface ModelSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel?: string;
  transport?: string;
}

interface LiveHarnessConfiguration {
  harness: "codex" | "claude-code" | "cursor";
  credentialSource: string;
  configSource: string;
}

export interface SandboxUserOptions {
  profile: SandboxUserProfile;
  root: string;
  sourcePiAgentDir?: string;
  protectedOwnerPaths?: string[];
  modelSettings?: ModelSettings;
  allowLiveHarness?: boolean;
  liveHarness?: LiveHarnessConfiguration;
}

interface SandboxCloseResult {
  daemonStopped: boolean;
  leasesRemaining: number;
  teardownVerified: boolean;
  preservedDiagnostics: string | null;
}

interface ManagedSession extends OwnerOperatorSession {
  sessionId: string;
}

/**
 * One disposable OS-user-shaped environment for behavioral and CLI evaluation.
 *
 * The primitive owns process environment, one daemon, production sessions, CLI
 * invocations, inspection, and secret-first teardown. Only one instance may be
 * alive in a process because production modules intentionally read process.env.
 */
export async function createSandboxUser(options: SandboxUserOptions) {
  if (options.profile === "live-harness" && !options.allowLiveHarness) {
    throw new Error("live-harness profile requires explicit opt-in");
  }
  if (options.profile === "live-harness" && !options.liveHarness) {
    throw new Error("live-harness profile requires explicit credential and config sources");
  }
  const materialized = materializeSandboxUser(options);
  const previousEnvironment = { ...process.env };
  replaceProcessEnvironment(materialized.env);
  let daemon: RunningDaemon | undefined;
  const sessions: ManagedSession[] = [];
  let productionCredentials: InMemoryCredentialStore | undefined;
  let closed = false;
  try {
    daemon = await startDaemon(daemonOptions(options.profile));
  } catch (error) {
    restoreProcessEnvironment(previousEnvironment);
    materialized.finalize({ teardownVerified: false, diagnostic: failureDiagnostic("daemon-start", error) });
    throw error;
  }

  const readTrace = (sessionId: string): string | null => {
    const sessionsDir = join(materialized.ooHome, "sessions");
    if (!existsSync(sessionsDir)) return null;
    const relative = readdirSync(sessionsDir, { recursive: true })
      .map(String)
      .find((file) => file.endsWith(".jsonl") && file.includes(sessionId));
    if (!relative) return null;
    return sanitizeEvalSessionTrace(
      readFileSync(join(sessionsDir, relative), "utf8"),
      materialized.diagnosticRedactions,
    );
  };

  return {
    ...materialized,
    daemon,
    async createProductionSession(input: {
      surface?: "chat" | "interactive" | "schedule";
      parentContext?: string;
      callerSessionId?: string;
    } = {}): Promise<ManagedSession> {
      if (options.profile === "fresh-onboarding") {
        throw new Error("fresh-onboarding profile cannot create a production session before consent");
      }
      if (!productionCredentials) {
        productionCredentials = await loadCredentialsIntoMemory(materialized.paths.piAuth);
        rmSync(materialized.paths.piAuth, { force: true });
      }
      const surface = input.surface ?? "chat";
      const sessionManager = createOoSession(ooProvenance(surface, input.callerSessionId));
      if (input.parentContext) {
        sessionManager.appendMessage({ role: "user", content: input.parentContext, timestamp: Date.now() });
      }
      const created = await createOwnerOperatorSession(surface, {
        cwd: materialized.taskCwd,
        sessionManager,
        callerSessionId: input.callerSessionId,
        credentials: productionCredentials,
      });
      const managed = { ...created, sessionId: sessionManager.getSessionId() };
      sessions.push(managed);
      return managed;
    },
    readSessionTrace: readTrace,
    credentialFileRemoved: () => !existsSync(materialized.paths.piAuth),
    leasesRemaining: () => leaseCount(materialized.ooHome),
    async runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      if (!isModelFreeCliInvocation(args)) {
        throw new Error("sandbox CLI driving is model-free; use createProductionSession for full-roster model turns");
      }
      return runCli(materialized.taskCwd, materialized.env, args);
    },
    async close(diagnostic: Record<string, unknown> = {}): Promise<SandboxCloseResult> {
      if (closed) throw new Error("sandbox user is already closed");
      closed = true;
      let closeError: unknown;
      for (const created of sessions.reverse()) {
        try {
          await shutdownSessionExtensions(created.session);
          created.session.dispose();
        } catch (error) {
          closeError ??= error;
        }
      }
      const port = daemon!.port;
      try {
        await daemon!.close();
      } catch (error) {
        closeError ??= error;
      }
      const daemonStopped = !existsSync(join(materialized.ooHome, "daemon.json"))
        && !await portResponds(port);
      const remaining = leaseCount(materialized.ooHome);
      const teardownVerified = !closeError && daemonStopped && remaining === 0;
      const preservedDiagnostics = materialized.finalize({
        teardownVerified,
        diagnostic: {
          kind: teardownVerified ? "sandbox-user-closed" : "sandbox-user-teardown-unverified",
          daemonStopped,
          leasesRemaining: remaining,
          ...(closeError ? { error: errorMessage(closeError) } : {}),
          ...diagnostic,
        },
      });
      restoreProcessEnvironment(previousEnvironment);
      return { daemonStopped, leasesRemaining: remaining, teardownVerified, preservedDiagnostics };
    },
  };
}

function materializeSandboxUser(options: SandboxUserOptions) {
  const protectedOwnerPaths = options.protectedOwnerPaths ?? [];
  const sandbox = evalSandboxUserPaths(options.root);
  const unexpected = existsSync(sandbox.root)
    ? readdirSync(sandbox.root).filter((name) => name !== "task" && name !== "tmp")
    : [];
  if (unexpected.length) throw new Error(`eval sandbox user root is not pristine: ${unexpected.join(", ")}`);
  mkdirSync(sandbox.taskCwd, { recursive: true });
  mkdirSync(sandbox.tempDir, { recursive: true });
  const paths = options.sourcePiAgentDir
    ? (importPiConfiguration(sandbox.ooHome, options.sourcePiAgentDir), ownerOperatorPaths(sandbox.ooHome))
    : ensureOwnerOperatorWorkspace(sandbox.ooHome);
  if (options.modelSettings) {
    const importedSettings = readJson(paths.piSettings);
    writeFileSync(paths.piSettings, `${JSON.stringify({
      ...importedSettings,
      defaultProvider: options.modelSettings.defaultProvider,
      defaultModel: options.modelSettings.defaultModel,
      ...(options.modelSettings.defaultThinkingLevel
        ? { defaultThinkingLevel: options.modelSettings.defaultThinkingLevel }
        : {}),
      transport: options.modelSettings.transport ?? "sse",
    }, null, 2)}\n`);
  }
  if (existsSync(paths.piAuth)) chmodSync(paths.piAuth, 0o600);
  writeFileSync(paths.sessionSources, `${JSON.stringify({
    disable: ["claude", "codex", "cursor", "posthog-code", "pi", "opencode", "antigravity", "grok-build"],
    add: [],
  }, null, 2)}\n`);
  writeFileSync(paths.blacklist, `${JSON.stringify({
    paths: [...new Set([
      paths.piAuth,
      ...protectedOwnerPaths.map((value) => resolve(value)),
    ])],
    repos: [],
  }, null, 2)}\n`);
  if (options.profile !== "fresh-onboarding") {
    markOnboarded(sandbox.ooHome, { via: `eval-${options.profile}` });
    savePermissionMode(sandbox.ooHome, "ask");
  }

  const copiedHarnessFiles = options.liveHarness
    ? copyLiveHarnessConfiguration(sandbox.userHome, options.liveHarness, sandbox.env)
    : [];
  const secretFiles = [paths.piAuth, paths.piSettings, paths.piModels, ...copiedHarnessFiles];
  const diagnosticRedactions = [
    ...(options.sourcePiAgentDir ? [options.sourcePiAgentDir] : []),
    ...protectedOwnerPaths,
    sandbox.root,
    sandbox.userHome,
    sandbox.ooHome,
    ...copiedHarnessFiles,
  ].map((value) => resolve(value));

  return {
    ...sandbox,
    paths,
    diagnosticRedactions,
    finalize({ teardownVerified, diagnostic = {} }: {
      teardownVerified: boolean;
      diagnostic?: Record<string, unknown>;
    }): string | null {
      for (const file of secretFiles) rmSync(file, { force: true });
      if (teardownVerified) {
        rmSync(sandbox.root, { recursive: true, force: true });
        return null;
      }
      const safeDiagnostic = sanitizeEvalDiagnosticValue(diagnostic, diagnosticRedactions);
      rmSync(sandbox.root, { recursive: true, force: true });
      const preserved = `${sandbox.root}/diagnostics`;
      mkdirSync(preserved, { recursive: true });
      writeFileSync(`${preserved}/diagnostic.json`, `${JSON.stringify(safeDiagnostic, null, 2)}\n`);
      return preserved;
    },
  };
}

function daemonOptions(profile: SandboxUserProfile): Parameters<typeof startDaemon>[0] {
  const shared = {
    port: 0,
    watch: false,
    enableEnrichment: false,
    monitor: { scan: async () => [], intervalMs: 60 * 60 * 1_000 },
    scheduler: { tickMs: 60 * 60 * 1_000 },
  };
  if (profile === "live-harness") return shared;
  return {
    ...shared,
    agentRuns: {
      maxConcurrent: 0,
      tickMs: 60 * 60 * 1_000,
      launcher: Object.assign(
        async () => { throw new Error("sandbox profile cannot launch a delegated child"); },
        { reapOrphans: async () => undefined },
      ),
    },
  };
}

const HARNESS_ISOLATION = {
  codex: { home: ".codex", credential: "auth.json", config: "config.toml" },
  "claude-code": { home: ".claude", credential: ".credentials.json", config: "settings.json" },
  cursor: { home: ".cursor", credential: "auth.json", config: "cli-config.json" },
} as const;

function copyLiveHarnessConfiguration(
  userHome: string,
  live: LiveHarnessConfiguration,
  environment: NodeJS.ProcessEnv,
): string[] {
  const isolation = HARNESS_ISOLATION[live.harness];
  const harnessHome = join(userHome, isolation.home);
  const credential = join(harnessHome, isolation.credential);
  const config = join(harnessHome, isolation.config);
  mkdirSync(harnessHome, { recursive: true });
  copyFileSync(resolve(live.credentialSource), credential);
  copyFileSync(resolve(live.configSource), config);
  chmodSync(credential, 0o600);
  if (live.harness === "codex") environment.CODEX_HOME = harnessHome;
  if (live.harness === "claude-code") environment.CLAUDE_CONFIG_DIR = harnessHome;
  if (live.harness === "cursor") {
    environment.CURSOR_CONFIG_DIR = harnessHome;
    environment.AGENT_CLI_CREDENTIAL_STORE = "file";
  }
  return [credential, config];
}

function replaceProcessEnvironment(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
}

function restoreProcessEnvironment(previous: NodeJS.ProcessEnv): void {
  replaceProcessEnvironment(previous);
}

function runCli(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", absoluteTsxLoaderPath(), join(repoRoot, "src", "cli", "oo.ts"), ...args],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function isModelFreeCliInvocation(args: string[]): boolean {
  return args.includes("--session-state")
    || args.includes("--done")
    || args.includes("--help")
    || args.includes("-h")
    || args[0] === "doctor"
    || args[0] === "status";
}

function leaseCount(home: string): number {
  const dir = join(home, "agent-runs", "process-leases");
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0;
}

async function portResponds(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
    return true;
  } catch {
    return false;
  }
}

function failureDiagnostic(kind: string, error: unknown): Record<string, unknown> {
  return { kind, error: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function loadCredentialsIntoMemory(file: string): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  for (const [providerId, credential] of Object.entries(readJson(file))) {
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) continue;
    await store.modify(providerId, async () => credential as Credential);
  }
  return store;
}
