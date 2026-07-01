// Owner Operator — the pi RPC agent, run as a CHILD of the `oo --rpc` supervisor (rpc.ts). It
// speaks pi's full RPC protocol on its own stdin/stdout; the supervisor owns the caller's channel
// and enforces the read-only allowlist, so this child only ever receives already-vetted commands.
// Not meant to be run directly — the launcher routes the internal `oo __rpc-agent` here.
import { runRpcMode } from "@earendil-works/pi-coding-agent";
import { createNeutralAgentRuntime } from "./agent";

const runtime = await createNeutralAgentRuntime();
await runRpcMode(runtime); // reads its own stdin (piped from the supervisor) until it closes
