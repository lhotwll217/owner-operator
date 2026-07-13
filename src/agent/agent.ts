// Owner Operator — shared agent core. One place builds the opinionated session (our
// prompt, skills, settings-driven model); frontends (CLI + pi interactive) run it.
// pi is the engine.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  AgentToolId,
  ensureOwnerOperatorWorkspace,
  isOnboarded,
  ownerOperatorPaths,
  type ScheduleExecutionResult,
  type ScheduledPromptRunRequest,
} from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";
import { createBlacklistAwareFileToolsExtension } from "./privacy-tools";
import { createOwnerOperatorPermissionExtension } from "./permissions";
import { ownerOperatorResourceLoaderOptions } from "./skills";
import { configuredOwnerOperatorTools, ownerOperatorCustomTools } from "./tools";

export { repoRoot };
export {
  getCurrentSessionStateTool,
  configuredOwnerOperatorTools,
  markThreadDoneTool,
  ownerOperatorCustomTools,
  ownerOperatorTools,
  queryDatabaseTool,
  schedulePromptTool,
} from "./tools";

export interface OwnerOperatorSession {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelLabel: string;
}

export interface OwnerOperatorSessionOptions {
  ephemeral?: boolean;
  sessionManager?: SessionManager;
  cwd?: string;
  callerSessionId?: string;
  toolsAllow?: readonly AgentToolId[];
}

export function evalSettingsOverrides(
  env: NodeJS.ProcessEnv,
): Parameters<SettingsManager["applyOverrides"]>[0] {
  const transport = env.OO_EVAL_TRANSPORT?.trim();
  const defaultProvider = env.OO_EVAL_DEFAULT_PROVIDER?.trim();
  const defaultModel = env.OO_EVAL_DEFAULT_MODEL?.trim();
  const defaultThinkingLevel = env.OO_EVAL_DEFAULT_THINKING?.trim() as
    | Parameters<SettingsManager["applyOverrides"]>[0]["defaultThinkingLevel"]
    | undefined;
  if (!transport && !defaultProvider && !defaultModel && !defaultThinkingLevel) return {};
  if (env.OO_EVAL_READ_ONLY !== "1") {
    throw new Error("OO_EVAL settings overrides are restricted to the read-only eval harness");
  }
  if (transport && transport !== "sse") {
    throw new Error(`Unsupported eval transport: ${transport}; expected sse`);
  }
  if (Boolean(defaultProvider) !== Boolean(defaultModel)) {
    throw new Error("OO_EVAL_DEFAULT_PROVIDER and OO_EVAL_DEFAULT_MODEL must be set together");
  }
  return {
    ...(transport ? { transport: "sse" as const } : {}),
    ...(defaultProvider && defaultModel ? { defaultProvider, defaultModel } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
  };
}

// The opinionated agent config, shared by every frontend so they can't drift: one prompt,
// one set of custom tools, one allowlist.
export const ownerOperatorPrompt = (): string =>
  readFileSync(join(repoRoot, "src", "prompts", "owner-operator.md"), "utf8");

export function ownerOperatorPiServices(ooHome?: string): {
  paths: ReturnType<typeof ownerOperatorPaths>;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
} {
  const paths = ensureOwnerOperatorWorkspace(ooHome);
  const authStorage = AuthStorage.create(paths.piAuth);
  return {
    paths,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage, paths.piModels),
    settingsManager: SettingsManager.create(paths.workspace, paths.piAgentDir, { projectTrusted: false }),
  };
}

// Every owner chat is saved (and labeled with its surface) like any other oo thread;
// `ephemeral` is the opt-out for tests that shouldn't leave files in OO_HOME.
export async function createOwnerOperatorSession(
  surface: "chat" | "interactive" | "schedule" = "chat",
  opts: OwnerOperatorSessionOptions = {},
): Promise<OwnerOperatorSession> {
  // Eval-only: OO_EVAL_BASELINE_PROMPT swaps the Operator for a naive session-search agent
  // — same binary, same model, same trace — so the eval's controlled arm differs from OO
  // by exactly its prompt and toolset (no DB/state tools). Product runs never set it.
  const baselinePrompt = process.env.OO_EVAL_BASELINE_PROMPT;
  const evalReadOnly = process.env.OO_EVAL_READ_ONLY === "1";
  const prompt = baselinePrompt ? readFileSync(baselinePrompt, "utf8") : ownerOperatorPrompt();
  const { authStorage, modelRegistry, paths, settingsManager } = ownerOperatorPiServices();
  const configuredTools = configuredOwnerOperatorTools(paths.home);
  const readOnlyCustomToolNames = new Set<string>([
    AgentToolId.GetCurrentSessionState,
    AgentToolId.QueryDatabase,
  ]);
  const customTools = baselinePrompt
    ? []
    : evalReadOnly
      ? ownerOperatorCustomTools.filter((tool) => readOnlyCustomToolNames.has(tool.name))
      : ownerOperatorCustomTools;
  const tools = baselinePrompt
    ? ["read", "bash"]
    : opts.toolsAllow
      ? opts.toolsAllow.filter((tool) => configuredTools.includes(tool))
      : evalReadOnly
        ? [
            AgentToolId.Bash,
            AgentToolId.Read,
            AgentToolId.GetCurrentSessionState,
            AgentToolId.QueryDatabase,
          ]
        : [...configuredTools];
  const cwd = opts.cwd ?? ownerOperatorTaskCwd();

  settingsManager.applyOverrides(evalSettingsOverrides(process.env));

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: paths.piAgentDir,
    settingsManager,
    ...ownerOperatorResourceLoaderOptions(),
    systemPromptOverride: () => prompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      createBlacklistAwareFileToolsExtension({ callerSessionId: opts.callerSessionId }),
      createOwnerOperatorPermissionExtension({
        surface: surface === "interactive" ? "interactive" : "headless",
        ooHome: paths.home,
      }),
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: paths.piAgentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager: opts.sessionManager ?? (opts.ephemeral ? SessionManager.inMemory(cwd) : createOoSession(ooProvenance(surface))),
    authStorage,
    modelRegistry,
    customTools,
    tools,
  });

  // A raw createAgentSession does not emit the extension lifecycle. Bind non-test sessions
  // so the privacy-aware file-tool overrides are active, then pair with shutdown before dispose.
  if (!opts.ephemeral) await session.bindExtensions({});

  const configuredModel = [settingsManager.getDefaultProvider(), settingsManager.getDefaultModel()]
    .filter(Boolean)
    .join("/");
  const modelLabel = session.model
    ? `${session.model.provider}/${session.model.id}`
    : configuredModel || "model unavailable";
  return { session, modelLabel };
}

/** Pi modes emit extension teardown on quit; raw-session surfaces must do it before dispose. */
export async function shutdownSessionExtensions(session: OwnerOperatorSession["session"]): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } catch {
    // best-effort: never let extension teardown block exit
  }
}

// ---- Where oo's own threads live, and how they're labeled ----------------------
// EVERY oo session persists under oo's OWN home, NEVER pi's default ~/.pi/agent/sessions,
// so the session monitor never scans oo's chatter as if it were one of the owner's coding sessions.
// This module owns that policy: callers build managers through the helpers below, which bake
// the dir in, instead of naming it themselves (pi silently falls back to its own dir when a
// manager isn't given one). Same OO_HOME base as the durable state database. Product threads
// use one stable identity cwd; isolated eval threads use their sandbox cwd consistently for
// create/list/resume. Tool execution is separate: it defaults to the caller's cwd.
//
// Every invocation stamps an `oo-provenance` custom entry (never sent to the LLM): WHICH
// surface, owner vs agent origin, the caller's cwd + repo, and — the audit trail — the
// calling coding session's id when the caller identifies itself (`--from-session` or
// OO_FROM_SESSION in the env). A resumed thread accrues one
// stamp per invocation, so "who touched this thread, from where" is greppable later.
const ooHome = (): string => process.env.OO_HOME ?? join(homedir(), ".owner-operator");
export const ooSessionsDir = (): string => join(ooHome(), "sessions");

export type OoSurface = "chat" | "interactive" | "schedule";
export interface OoProvenance {
  surface: OoSurface;
  origin: "owner" | "agent" | "scheduler";
  callerCwd: string; // where the process was invoked from (the launcher doesn't cd)
  callerRepo: string; // basename of the caller's git repo, or of the cwd outside one
  fromSession?: string; // audit: the coding session that called us, when it says so
  ppid: number; // best-effort process audit (an agent shelling out shows as its shell)
  schedule?: {
    jobId: string;
    runId: string;
    jobName: string;
    trigger: string;
  };
}

export function ooProvenance(surface: OoSurface, fromSession?: string): OoProvenance {
  const cwd = process.cwd();
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const callerSession = [fromSession, process.env.OO_FROM_SESSION, process.env.CODEX_THREAD_ID]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  return {
    surface,
    origin: callerSession ? "agent" : "owner",
    callerCwd: cwd,
    callerRepo: basename((git.status === 0 && git.stdout.trim()) || cwd),
    fromSession: callerSession,
    ppid: process.ppid,
  };
}

export function stampProvenance(sm: SessionManager, p: OoProvenance): void {
  sm.appendCustomEntry("oo-provenance", p);
  if (!sm.getSessionName()) sm.appendSessionInfo(`${p.surface}${p.fromSession ? ` ← ${p.fromSession}` : ""} @ ${p.callerRepo}`);
}

/** A fresh oo thread, stamped with its surface + caller provenance. */
export function createOoSession(provenance: OoProvenance): SessionManager {
  const sm = SessionManager.create(sessionIdentityCwd(), ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}

/** Task tools operate where `oo` was invoked; evals override this with their isolated sandbox. */
export function ownerOperatorTaskCwd(): string {
  return process.env.OO_EVAL_CWD || process.cwd();
}

/** Keep OO thread lookup stable across caller directories; evals remain sandbox-scoped. */
function sessionIdentityCwd(): string {
  return process.env.OO_EVAL_CWD || repoRoot;
}
/** Resume the most recent oo thread (or a fresh one if none); each resume re-stamps. */
export function continueOoSession(provenance: OoProvenance): SessionManager {
  const sm = SessionManager.continueRecent(sessionIdentityCwd(), ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}
/** List oo threads — for resolving a `--session <id>` reference. */
export const listOoSessions = () => SessionManager.list(sessionIdentityCwd(), ooSessionsDir());
/** Open a specific oo thread file (re-stamped by the caller), keeping oo's dir for /new or /fork. */
export function openOoSession(path: string, provenance: OoProvenance): SessionManager {
  const sm = SessionManager.open(path, ooSessionsDir());
  stampProvenance(sm, provenance);
  return sm;
}

export function lastAssistantText(session: OwnerOperatorSession["session"]): string {
  const msgs: any[] = (session as any).state?.messages ?? [];
  const m = [...msgs].reverse().find((x) => x.role === "assistant");
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
  return m?.text ?? "";
}

export function lastAssistantError(session: OwnerOperatorSession["session"]): string | null {
  const msgs: any[] = (session as any).state?.messages ?? [];
  const message = [...msgs].reverse().find((item) => item.role === "assistant");
  if (message?.stopReason !== "error") return null;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : "model turn stopped with an error";
}

/** Fresh persisted session per scheduled run; never attaches to an active Pi conversation. */
export async function runScheduledPrompt(request: ScheduledPromptRunRequest): Promise<ScheduleExecutionResult> {
  const paths = ensureOwnerOperatorWorkspace();
  if (!isOnboarded(paths.home)) {
    return { exitCode: 1, stdout: "", stderr: "Owner Operator setup required; run `oo` interactively." };
  }
  const sessionManager = SessionManager.create(request.cwd, ooSessionsDir());
  const provenance: OoProvenance = {
    surface: "schedule",
    origin: "scheduler",
    callerCwd: request.cwd,
    callerRepo: basename(request.cwd),
    ppid: process.ppid,
    schedule: {
      jobId: request.schedule.id,
      runId: request.runId,
      jobName: request.schedule.name,
      trigger: request.schedule.trigger.kind,
    },
  };
  stampProvenance(sessionManager, provenance);
  const { session } = await createOwnerOperatorSession("schedule", {
    cwd: request.cwd,
    sessionManager,
    toolsAllow: request.payload.toolsAllow,
  });
  const abort = (): void => { void session.abort(); };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    const prompt = request.triggerContext === undefined
      ? request.payload.prompt
      : `${request.payload.prompt}\n\nTrigger context:\n${JSON.stringify(request.triggerContext, null, 2)}`;
    await session.prompt(prompt);
    const error = lastAssistantError(session);
    return {
      exitCode: error ? 1 : 0,
      stdout: lastAssistantText(session),
      stderr: error ?? "",
      transcriptId: sessionManager.getSessionId(),
    };
  } finally {
    request.signal.removeEventListener("abort", abort);
    await shutdownSessionExtensions(session);
    session.dispose();
  }
}
