import assert from "node:assert/strict";
import { AgentRunStatus, GatewayEventKind, type GatewayApi } from "@owner-operator/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentRunFixture as run } from "../../test/fixtures/agent-run";
import { createInteractiveAgentRunDeliveryExtension } from "./agent-run-delivery-extension";
import { AGENT_RUN_COMPLETION_MESSAGE_TYPE } from "./agent-run-completion";

const handlers = new Map<string, Function>();
const commands: string[] = [];
const statuses: unknown[] = [];
const messages: Array<{ message: any; options: any }> = [];
const notices: string[] = [];
const scopes: Array<string | undefined> = [];
let listener: ((event: { kind: GatewayEventKind }) => void) | undefined;
let connected: (() => void) | undefined;
let subscriptions = 0;
let unsubscriptions = 0;
let rows = [run("running", AgentRunStatus.Running)];
let attempts = 0;
const gateway = {
  listAgentRuns: async (parent?: string) => { scopes.push(parent); return rows; },
  subscribe: (onEvent: typeof listener, onConnected?: () => void) => {
    listener = onEvent;
    connected = onConnected;
    subscriptions += 1;
    return () => { unsubscriptions += 1; };
  },
} as Pick<GatewayApi, "listAgentRuns" | "subscribe">;
const pi = {
  on(name: string, handler: Function) { handlers.set(name, handler); },
  registerCommand(name: string) { commands.push(name); },
  registerMessageRenderer(type: string) { assert.equal(type, AGENT_RUN_COMPLETION_MESSAGE_TYPE); },
  sendMessage(message: any, options: any) { messages.push({ message, options }); },
} as unknown as ExtensionAPI;
const ctx = {
  mode: "tui",
  sessionManager: { getSessionId: () => "parent-90", getEntries: () => [] },
  ui: {
    notify(message: string) { notices.push(message); },
    setStatus(...args: unknown[]) { statuses.push(args); },
    custom() { throw new Error("completion delivery must not open a picker"); },
  },
};
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("delivery did not settle");
}

createInteractiveAgentRunDeliveryExtension({
  retryDelayMs: 1,
  resolveGateway: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("daemon replacing");
    return gateway as GatewayApi;
  },
})(pi);
await handlers.get("session_start")!({}, ctx);
assert.deepEqual(notices, ["Agent completion delivery unavailable: daemon replacing"]);
await waitFor(() => scopes.length >= 2);
assert.deepEqual(scopes, ["parent-90", "parent-90"]);
assert.equal(subscriptions, 1);
rows = [run("running", AgentRunStatus.Failed, { error: "handshake failed" })];
listener!({ kind: GatewayEventKind.AgentRunChanged });
await waitFor(() => messages.length === 1);
assert.equal(messages[0].message.customType, AGENT_RUN_COMPLETION_MESSAGE_TYPE);
assert.equal(messages[0].message.details.envelopes[0].runId, "running");
assert.equal(messages[0].message.details.envelopes[0].outcome, "failed");
assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
const previousReads = scopes.length;
connected!();
await waitFor(() => scopes.length > previousReads);
await handlers.get("session_shutdown")!({}, ctx);
assert.equal(unsubscriptions, 1);
assert.deepEqual(commands, []);
assert.deepEqual(statuses, []);

let rejectLate!: (error: Error) => void;
createInteractiveAgentRunDeliveryExtension({
  retryDelayMs: 1,
  resolveGateway: () => new Promise<GatewayApi>((_resolve, reject) => { rejectLate = reject; }),
})(pi);
const start = handlers.get("session_start")!({}, ctx);
await handlers.get("session_shutdown")!({}, ctx);
rejectLate(new Error("late failure"));
await start;
assert.deepEqual(notices, ["Agent completion delivery unavailable: daemon replacing"]);
assert.equal(subscriptions, 1);

process.stdout.write("ok — interactive completion delivery survives retry and reconnect without a picker or footer\n");
