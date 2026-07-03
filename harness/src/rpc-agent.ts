// Owner Operator — the pi RPC agent, run as a CHILD of the `oo --rpc` supervisor (rpc.ts). It
// speaks pi's full RPC protocol on its own stdin/stdout; the supervisor owns the caller's channel
// and enforces the read-only allowlist, so this child only ever receives already-vetted commands.
// Not meant to be run directly — the launcher routes the internal `oo __rpc-agent` here.
import { runRpcMode } from "@earendil-works/pi-coding-agent";
import { createNeutralAgentRuntime, createOoSession, ooProvenance } from "./agent";

// The channel's thread is saved like every oo session, stamped surface=rpc with the
// caller's cwd/repo (OO_FROM_SESSION in the env adds the calling session id).
const runtime = await createNeutralAgentRuntime(createOoSession(ooProvenance("rpc")));
await runRpcMode(runtime); // reads its own stdin (piped from the supervisor) until it closes
