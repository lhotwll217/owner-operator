import assert from "node:assert";
import {
  AgentRunHarness,
  AgentRunStatus,
  GatewayEventKind,
  type GatewayApi,
} from "@owner-operator/core";
import { deriveParentAgentState } from "@owner-operator/core/agent-state";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildOoTheme } from "../shared/oo-presentation";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import {
  AgentStatePicker,
  createAgentStateExtension,
  formatAgentElapsed,
  type AgentStatePickerAction,
} from "./agent-state-extension";

const rows = [
  run("completed", AgentRunStatus.Completed, { task: "Task completed", resultTail: "Report ready" }),
  run("running", AgentRunStatus.Running, {
    task: "Task running",
    harness: AgentRunHarness.Codex,
    activity: "Reviewing the gateway reconnect path",
  }),
  run("failed", AgentRunStatus.Failed, {
    task: "Investigate ACP startup",
    error: "Handshake failed",
    childSessionId: "failed-child",
  }),
];
const view = deriveParentAgentState(rows, { now: "2026-07-21T12:10:00.000Z" });
const theme = buildOoTheme("256color");
const actions: AgentStatePickerAction[] = [];
const picker = new AgentStatePicker(view, theme, (action) => actions.push(action), () => undefined);

const wide = picker.render(100).join("\n");
assert.match(wide, /Agent state/);
assert.ok(wide.indexOf("Investigate ACP startup") < wide.indexOf("Task running"), "attention renders before active");
assert.ok(wide.indexOf("Task running") < wide.indexOf("Task completed"), "active renders before recent terminal");
assert.match(wide, /! failed/);
assert.match(wide, /● running/);
assert.match(wide, /✓ completed/);
assert.match(wide, /Task:/);
assert.match(wide, /Harness:/);
assert.match(wide, /Status:/);
assert.match(wide, /Elapsed:/);
assert.match(wide, /Activity:/);

const narrowLines = picker.render(32);
assert.ok(narrowLines.every((line) => visibleWidth(line) <= 32), "every picker line fits a narrow terminal");
const accessibleText = narrowLines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
assert.match(accessibleText, /Selected · ! failed/, "screen-reader order names selection, glyph, and status text");
assert.match(accessibleText, /Status:/);
assert.match(accessibleText, /Harness:/);
assert.equal(formatAgentElapsed(540_000), "9m");

picker.handleInput("c");
assert.deepEqual(actions, [], "cancel is unavailable for the selected terminal failure");
picker.handleInput("\u001b[B");
picker.handleInput("c");
assert.deepEqual(actions, [{ kind: "cancel", runId: "running" }]);
actions.length = 0;
picker.handleInput("\u001b[A");
picker.handleInput("r");
assert.deepEqual(actions, [{ kind: "resume", runId: "failed" }]);

// Extension integration: parent id scopes the first list, one subscription feeds the literal
// footer and picker, cancellation is confirmed, and shutdown clears both subscription/footer.
const calls: string[] = [];
let gatewayListener: ((event: { kind: GatewayEventKind }) => void) | undefined;
let gatewayRows = [run("running", AgentRunStatus.Running)];
const gateway = {
  listAgentRuns: async (parent?: string) => { calls.push(`list:${parent}`); return gatewayRows; },
  cancelAgentRun: async (id: string) => {
    calls.push(`cancel:${id}`);
    const cancelled = run(id, AgentRunStatus.Cancelled);
    gatewayRows = [cancelled];
    return cancelled;
  },
  resumeAgentRun: async (id: string) => { calls.push(`resume:${id}`); return run(`${id}-resumed`, AgentRunStatus.Pending); },
  subscribe: (listener: typeof gatewayListener) => {
    calls.push("subscribe");
    gatewayListener = listener;
    return () => calls.push("unsubscribe");
  },
} as Pick<GatewayApi, "listAgentRuns" | "cancelAgentRun" | "resumeAgentRun" | "subscribe">;

const handlers = new Map<string, Function>();
let command: { handler(args: string, ctx: any): Promise<void> } | undefined;
const extension = createAgentStateExtension({ resolveGateway: async () => gateway as GatewayApi });
extension({
  on(name: string, handler: Function) { handlers.set(name, handler); },
  registerCommand(name: string, value: typeof command) { if (name === "agent-state") command = value; },
} as any);

const statuses: Array<string | undefined> = [];
let confirmed = false;
const notices: string[] = [];
const ctx = {
  mode: "tui",
  sessionManager: { getSessionId: () => "parent-90" },
  ui: {
    theme,
    setStatus(_key: string, text: string | undefined) { statuses.push(text); },
    notify(message: string) { notices.push(message); },
    confirm: async () => confirmed,
    custom: async (factory: Function) => await new Promise((resolve) => {
      const component = factory({ requestRender() {} }, theme, {}, resolve);
      component.handleInput("c");
    }),
  },
};
await handlers.get("session_start")?.({}, ctx);
assert.deepEqual(calls.slice(0, 2), ["list:parent-90", "subscribe"]);
assert.ok(statuses.includes("Agent state: 1 running"));
assert.ok(command);
await command!.handler("", ctx);
assert.ok(!calls.includes("cancel:running"), "declined confirmation does not cancel");
confirmed = true;
await command!.handler("", ctx);
assert.ok(calls.includes("cancel:running"), "confirmed picker action cancels through the parent session");
assert.equal(statuses.at(-1), undefined, "routine terminal completion hides the footer");

gatewayListener?.({ kind: GatewayEventKind.AgentRunChanged });
await new Promise<void>((resolve) => setImmediate(resolve));
await handlers.get("session_shutdown")?.({}, ctx);
assert.equal(calls.filter((call) => call === "subscribe").length, 1);
assert.ok(calls.includes("unsubscribe"));
assert.equal(statuses.at(-1), undefined);
assert.deepEqual(notices, []);

const unavailableHandlers = new Map<string, Function>();
let resolveAttempts = 0;
gatewayRows = [run("running", AgentRunStatus.Running)];
createAgentStateExtension({
  retryDelayMs: 1,
  resolveGateway: async () => {
    resolveAttempts += 1;
    if (resolveAttempts === 1) throw new Error("daemon replacing");
    return gateway as GatewayApi;
  },
})({
  on(name: string, handler: Function) { unavailableHandlers.set(name, handler); },
  registerCommand() {},
} as any);
await assert.doesNotReject(
  () => unavailableHandlers.get("session_start")?.({}, ctx),
  "agent-state startup failure does not block the parent TUI",
);
assert.match(notices.at(-1) ?? "", /Agent state unavailable: daemon replacing/);
await new Promise<void>((resolve) => setTimeout(resolve, 10));
assert.ok(resolveAttempts >= 2, "an open parent retries when Gateway returns");
assert.ok(statuses.includes("Agent state: 1 running"), "retry reconstructs the durable parent projection");
await unavailableHandlers.get("session_shutdown")?.({}, ctx);

const staleHandlers = new Map<string, Function>();
let rejectStale!: (error: Error) => void;
createAgentStateExtension({
  retryDelayMs: 1,
  resolveGateway: () => new Promise<GatewayApi>((_resolve, reject) => { rejectStale = reject; }),
})({
  on(name: string, handler: Function) { staleHandlers.set(name, handler); },
  registerCommand() {},
} as any);
const staleStart = staleHandlers.get("session_start")?.({}, ctx);
await staleHandlers.get("session_shutdown")?.({}, ctx);
const statusCountAfterShutdown = statuses.length;
const noticeCountAfterShutdown = notices.length;
rejectStale(new Error("late replacement failure"));
await staleStart;
assert.equal(statuses.length, statusCountAfterShutdown, "a stale retry cannot clear a newer session footer");
assert.equal(notices.length, noticeCountAfterShutdown, "a stale retry cannot notify through an invalidated Pi context");

const lateListHandlers = new Map<string, Function>();
let resolveLateList!: (rows: typeof gatewayRows) => void;
let lateListCalls = 0;
const lateListGateway = {
  ...gateway,
  listAgentRuns: () => {
    lateListCalls += 1;
    if (lateListCalls > 1) return Promise.resolve([run("late-running", AgentRunStatus.Running)]);
    return new Promise<typeof gatewayRows>((resolve) => { resolveLateList = resolve; });
  },
};
createAgentStateExtension({ resolveGateway: async () => lateListGateway as GatewayApi })({
  on(name: string, handler: Function) { lateListHandlers.set(name, handler); },
  registerCommand() {},
} as any);
const lateListStart = lateListHandlers.get("session_start")?.({}, ctx);
await new Promise<void>((resolve) => setImmediate(resolve));
await lateListHandlers.get("session_shutdown")?.({}, ctx);
const statusCountBeforeLateList = statuses.length;
resolveLateList([run("late-running", AgentRunStatus.Running)]);
await lateListStart;
assert.equal(statuses.length, statusCountBeforeLateList, "late reconciliation cannot restore a stale parent footer");

process.stdout.write("ok — literal agent-state footer and accessible picker controls\n");
