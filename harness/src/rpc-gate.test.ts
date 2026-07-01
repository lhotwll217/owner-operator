// Unit: the `oo --rpc` command allowlist (classifyRpcLine). No model, no disk.
import assert from "node:assert";
import { classifyRpcLine } from "./rpc-gate";

// Allowed (read-only / prompting) commands forward untouched.
for (const type of ["prompt", "steer", "follow_up", "abort", "get_state", "get_last_assistant_text", "get_messages"]) {
  assert.deepEqual(classifyRpcLine(JSON.stringify({ type, id: "x" })), { forward: true }, `${type} forwarded`);
}

// Allowlist means DEFAULT DENY: known-dangerous AND unknown/future commands are rejected, with an
// id-preserving error response in the protocol shape.
for (const type of ["bash", "set_model", "switch_session", "export_html", "new_session", "fork", "compact", "totally_unknown_future_cmd"]) {
  const d = classifyRpcLine(JSON.stringify({ type, id: "abc" }));
  assert.equal(d.forward, false, `${type} blocked`);
  const r = JSON.parse((d as { forward: false; response: string }).response);
  assert.deepEqual([r.type, r.command, r.success, r.id], ["response", type, false, "abc"], `${type} → id-preserving error`);
}

// Unparseable JSON is forwarded so runRpcMode reports the protocol error itself.
assert.deepEqual(classifyRpcLine("not json {{{"), { forward: true }, "bad JSON forwarded");

// A command with no id still gets a (id-less) rejection, not a crash.
const noId = classifyRpcLine(JSON.stringify({ type: "bash" }));
assert.equal(noId.forward, false, "bash without id blocked");
assert.equal(JSON.parse((noId as { forward: false; response: string }).response).id, undefined, "no id echoed when none sent");

process.stdout.write("ok — rpc gate: allowlist forwards safe, denies unknown/mutating, id-preserving error\n");
