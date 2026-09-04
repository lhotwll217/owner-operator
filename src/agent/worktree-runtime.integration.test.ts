import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { AgentToolId, type ResolveWorktreeCwdRequest } from "@owner-operator/core";
import {
  bindOwnerOperatorSessionExtensions,
  createOwnerOperatorSession,
  ooProvenance,
  ownerOperatorPiServices,
  sessionIdentityCwd,
} from "./agent";
import {
  createWorktreeRuntimeRebindExtension,
  InteractiveSessionReplacement,
  PendingWorktreeCwdChanges,
  resolveInteractiveRuntimeTarget,
  resolveOwnerOperatorTaskCwd,
} from "./worktree-runtime";

const root = mkdtempSync(join(tmpdir(), "oo-worktree-runtime-"));
const previousOoHome = process.env.OO_HOME;
const previousEvalCwd = process.env.OO_EVAL_CWD;

try {
  const ooHome = join(root, "oo-home");
  const identityCwd = join(root, "install-root");
  const fallbackCwd = join(root, "invocation-fallback");
  const selectedCwd = join(root, "selected-worktree");
  for (const path of [join(ooHome, "pi"), identityCwd, fallbackCwd, selectedCwd]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(ooHome, "pi", "settings.json"), "{}");
  process.env.OO_HOME = ooHome;
  process.env.OO_EVAL_CWD = identityCwd;

  const calls: ResolveWorktreeCwdRequest[] = [];
  const selectedIds = new Set(["startup", "continued", "specific", "resumed", "forked"]);
  const resolveGateway = async () => ({
    async resolveWorktreeCwd(request: ResolveWorktreeCwdRequest) {
      calls.push(request);
      return selectedIds.has(request.threadId)
        ? { cwd: selectedCwd, selected: true as const, worktreeId: "worktree-05" }
        : { cwd: request.fallbackCwd, selected: false as const };
    },
  });
  const provenance = ooProvenance("interactive");
  const manager = (id: string, cwd = identityCwd) => SessionManager.inMemory(cwd, { id });
  const modes: Array<{
    label: string;
    manager: SessionManager;
    event?: SessionStartEvent;
    expectedCwd: string;
  }> = [
    { label: "interactive startup", manager: manager("startup"), expectedCwd: selectedCwd },
    {
      label: "/new",
      manager: manager("new-root", selectedCwd),
      event: { type: "session_start", reason: "new", previousSessionFile: "/previous.jsonl" },
      expectedCwd: fallbackCwd,
    },
    {
      label: "/resume",
      manager: manager("resumed"),
      event: { type: "session_start", reason: "resume", previousSessionFile: "/previous.jsonl" },
      expectedCwd: selectedCwd,
    },
    {
      label: "/fork",
      manager: manager("forked", selectedCwd),
      event: { type: "session_start", reason: "fork", previousSessionFile: "/previous.jsonl" },
      expectedCwd: selectedCwd,
    },
  ];
  for (const mode of modes) {
    const target = await resolveInteractiveRuntimeTarget(
      mode.manager,
      mode.event,
      provenance,
      fallbackCwd,
      { resolveGateway },
    );
    assert.equal(target.cwd, mode.expectedCwd, `${mode.label} resolves before runtime construction`);
    assert.equal(target.sessionManager.getSessionId(), mode.manager.getSessionId(),
      `${mode.label} retains stable OO session identity`);
    assert.equal(target.sessionManager.getHeader()?.cwd, sessionIdentityCwd(),
      `${mode.label} keeps install-root header identity separate from execution cwd`);
  }

  for (const id of ["continued", "specific"]) {
    assert.equal(await resolveOwnerOperatorTaskCwd(manager(id), fallbackCwd, { resolveGateway }), selectedCwd,
      `headless ${id === "continued" ? "continue" : "specific-session"} startup resolves selection`);
  }
  assert.equal(await resolveOwnerOperatorTaskCwd(manager("headless-new"), fallbackCwd, { resolveGateway }), fallbackCwd,
    "headless new startup retains invocation fallback when no selection exists");
  assert.deepEqual(calls.map(({ threadId }) => threadId), [
    "startup", "new-root", "resumed", "forked", "continued", "specific", "headless-new",
  ], "every startup and replacement mode uses the same stable-id resolver");

  let sameRuntimeSelected = false;
  let sameRuntimeResolutionError: Error | undefined;
  const sameRuntimeManager = SessionManager.create(identityCwd, join(ooHome, "sessions"), {
    id: "same-runtime",
  });
  sameRuntimeManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "persist runtime fixture" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  const sameRuntimeGateway = async () => ({
    async resolveWorktreeCwd(request: ResolveWorktreeCwdRequest) {
      if (sameRuntimeResolutionError) throw sameRuntimeResolutionError;
      return sameRuntimeSelected && request.threadId === "same-runtime"
        ? { cwd: selectedCwd, selected: true as const, worktreeId: "worktree-05" }
        : { cwd: request.fallbackCwd, selected: false as const };
    },
  });
  const piServices = await ownerOperatorPiServices(ooHome);
  const actualPending = new PendingWorktreeCwdChanges();
  const actualReplacement = new InteractiveSessionReplacement();
  let sameRuntime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  const actualRebindExtension = createWorktreeRuntimeRebindExtension({
    pending: actualPending,
    replacement: actualReplacement,
    rebind: async (threadId) => {
      assert.equal(sameRuntime?.session.sessionManager.getSessionId(), threadId);
      await resolveOwnerOperatorTaskCwd(
        sameRuntime!.session.sessionManager,
        fallbackCwd,
        { resolveGateway: sameRuntimeGateway },
      );
      await sameRuntime!.switchSession(sameRuntime!.session.sessionManager.getSessionFile()!);
    },
  });
  const sameRuntimeFactory: Parameters<typeof createAgentSessionRuntime>[0] = async (options) => {
    const target = await resolveInteractiveRuntimeTarget(
      options.sessionManager,
      options.sessionStartEvent,
      provenance,
      fallbackCwd,
      { resolveGateway: sameRuntimeGateway },
    );
    const replacedThreadId = actualReplacement.complete();
    if (replacedThreadId) actualPending.discard(replacedThreadId);
    const services = await createAgentSessionServices({
      cwd: target.cwd,
      agentDir: piServices.paths.piAgentDir,
      modelRuntime: piServices.modelRuntime,
      settingsManager: piServices.settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => "runtime fixture",
        appendSystemPromptOverride: () => [],
        extensionFactories: [{ name: "post-turn-rebind", factory: actualRebindExtension }],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      tools: ["read"],
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  sameRuntime = await createAgentSessionRuntime(sameRuntimeFactory, {
    cwd: fallbackCwd,
    agentDir: piServices.paths.piAgentDir,
    sessionManager: sameRuntimeManager,
  });
  assert.equal(sameRuntime.cwd, fallbackCwd);
  sameRuntimeSelected = true;
  sameRuntimeResolutionError = new Error("selected path disappeared");
  const survivingSession = sameRuntime.session;
  actualPending.record("same-runtime");
  await sameRuntime.session.extensionRunner.emit({ type: "agent_settled" });
  assert.equal(sameRuntime.session, survivingSession,
    "failed preflight does not dispose the current session before Pi's replacement factory runs");
  assert.equal(sameRuntime.cwd, fallbackCwd,
    "failed preflight leaves the current cwd-bound services usable");
  sameRuntimeResolutionError = undefined;
  actualPending.record("same-runtime");
  await sameRuntime.session.extensionRunner.emit({ type: "agent_settled" });
  assert.equal(sameRuntime.cwd, selectedCwd, "post-turn replacement rebuilds cwd-bound services");
  assert.equal(sameRuntime.session.sessionManager.getSessionId(), "same-runtime",
    "post-turn replacement reopens the same stable session instead of forking identity");
  assert.equal(sameRuntime.session.sessionManager.getHeader()?.cwd, identityCwd,
    "same-session replacement does not rewrite the stable transcript header");
  await sameRuntime.newSession();
  assert.notEqual(sameRuntime.session.sessionManager.getSessionId(), "same-runtime");
  assert.equal(sameRuntime.cwd, fallbackCwd, "an actual /new replacement resolves its new root fallback");
  assert.equal(sameRuntime.session.sessionManager.getHeader()?.cwd, identityCwd,
    "an actual /new replacement normalizes Pi's runtime-derived header to stable OO identity");
  await sameRuntime.dispose();

  const pending = new PendingWorktreeCwdChanges();
  const replacement = new InteractiveSessionReplacement();
  const ordering: string[] = [];
  let settledHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  const extension = createWorktreeRuntimeRebindExtension({
    pending,
    replacement,
    rebind: async (threadId) => { ordering.push(`rebind:${threadId}`); },
  });
  extension({
    on(event: string, handler: unknown) {
      if (event === "agent_settled") {
        settledHandler = handler as typeof settledHandler;
      }
    },
  } as never);
  assert.ok(settledHandler);
  const context = {
    sessionManager: { getSessionId: () => "same-session" },
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
  pending.record("same-session");
  ordering.push("select");
  ordering.push("turn_end");
  await settledHandler({}, context);
  assert.deepEqual(ordering, ["select", "turn_end", "rebind:same-session"],
    "selection rebinds the same session only after the selecting turn settles");
  await settledHandler({}, context);
  assert.equal(ordering.length, 3, "one pending selection causes one runtime rebuild");

  const replacementPending = new PendingWorktreeCwdChanges();
  const outerReplacement = new InteractiveSessionReplacement();
  let replacementRebinds = 0;
  let beforeSwitchHandler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let beforeForkHandler: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let replacementSettledHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  createWorktreeRuntimeRebindExtension({
    pending: replacementPending,
    replacement: outerReplacement,
    rebind: async () => { replacementRebinds += 1; },
  })({
    on(event: string, handler: unknown) {
      if (event === "session_before_switch") beforeSwitchHandler = handler as typeof beforeSwitchHandler;
      if (event === "session_before_fork") beforeForkHandler = handler as typeof beforeForkHandler;
      if (event === "agent_settled") replacementSettledHandler = handler as typeof replacementSettledHandler;
    },
  } as never);
  assert.ok(beforeSwitchHandler);
  assert.ok(beforeForkHandler);
  assert.ok(replacementSettledHandler);
  for (const beginReplacement of [beforeSwitchHandler, beforeForkHandler]) {
    replacementPending.record("same-session");
    beginReplacement!({}, context);
    await replacementSettledHandler({}, context);
    assert.equal(replacementRebinds, 0,
      "settling an outgoing turn does not start a nested cwd replacement");
    assert.equal(replacementPending.has("same-session"), true,
      "outer replacement startup retains the selection until its resolver applies it");
    const replacedThreadId = outerReplacement.complete();
    assert.equal(replacedThreadId, "same-session");
    replacementPending.discard(replacedThreadId);
    await replacementSettledHandler({}, context);
    assert.equal(replacementRebinds, 0,
      "a completed outer replacement leaves no pending handler or duplicate rebind");
  }

  const failedPending = new PendingWorktreeCwdChanges();
  const failedReplacement = new InteractiveSessionReplacement();
  const notices: string[] = [];
  let failedHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
  createWorktreeRuntimeRebindExtension({
    pending: failedPending,
    replacement: failedReplacement,
    rebind: async () => { throw new Error("selected path disappeared"); },
  })({
    on(event: string, handler: unknown) {
      if (event === "agent_settled") failedHandler = handler as typeof failedHandler;
    },
  } as never);
  assert.ok(failedHandler);
  failedPending.record("same-session");
  await failedHandler!({}, {
    ...context,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext);
  assert.match(notices.join("\n"), /Selected worktree could not be activated: selected path disappeared/,
    "production-shaped handler failure is visibly reported even though Pi swallows extension errors");

  writeFileSync(join(selectedCwd, "cwd-marker.txt"), "selected runtime\n");
  writeFileSync(join(fallbackCwd, "cwd-marker.txt"), "fallback runtime\n");
  const bound = await createOwnerOperatorSession("chat", {
    cwd: selectedCwd,
    ephemeral: true,
    toolsAllow: [AgentToolId.Read],
  });
  await bindOwnerOperatorSessionExtensions(bound.session);
  const read = bound.session.extensionRunner.getToolDefinition("read");
  assert.ok(read);
  const runtimeCwd = (bound.session as unknown as { _cwd: string })._cwd;
  assert.equal(runtimeCwd, selectedCwd, "the Owner Operator session itself receives the resolved cwd");
  const readResult = await read.execute(
    "read-cwd",
    { path: "cwd-marker.txt" },
    undefined,
    undefined,
    { cwd: runtimeCwd } as never,
  );
  assert.match(JSON.stringify(readResult.content), /selected runtime/,
    "the rebuilt runtime's built-in read tool is bound to the resolved cwd");
  assert.doesNotMatch(JSON.stringify(readResult.content), /fallback runtime/);
  bound.session.dispose();

  process.stdout.write("ok — every OO startup/replacement resolves cwd and post-turn rebind preserves identity\n");
} finally {
  if (previousOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = previousOoHome;
  if (previousEvalCwd === undefined) delete process.env.OO_EVAL_CWD;
  else process.env.OO_EVAL_CWD = previousEvalCwd;
  rmSync(root, { recursive: true, force: true });
}
