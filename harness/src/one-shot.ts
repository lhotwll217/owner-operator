// Owner Operator — `oo one-shot "<question>"`: the agent-to-agent channel as a single
// invocation. Same neutral read-only session as `oo --rpc` (agent-rpc prompt, no shell,
// scan/search skills), but one prompt in → the assistant's final text on stdout → exit.
// No protocol to speak, no channel to hold open; the caller never reaches pi's RPC
// commands, so there is nothing for the rpc-gate to vet. The trade is that nothing
// persists between calls — every invocation starts a fresh thread.
import { runPrintMode } from "@earendil-works/pi-coding-agent";
import { createNeutralAgentRuntime } from "./agent";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  process.stderr.write('usage: oo one-shot "<question>"\n');
  process.exit(2);
}

const runtime = await createNeutralAgentRuntime();
process.exit(await runPrintMode(runtime, { mode: "text", initialMessage: prompt }));
