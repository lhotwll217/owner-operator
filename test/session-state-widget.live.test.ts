import { runSessionStateWidgetProof } from "./session-state-widget-proof";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.env.OO_WIDGET_PROOF_LIVE !== "1") {
  console.log("skip - set OO_WIDGET_PROOF_LIVE=1 for paid Luna-medium widget proof");
} else {
  const credentialSource = process.env.OO_WIDGET_PROOF_CREDENTIAL_SOURCE;
  if (!credentialSource) throw new Error("live proof requires an explicit credential source directory");
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) throw new Error("live proof requires a clean committed worktree");
  const nativeBinary = process.env.OO_WIDGET_PROOF_NATIVE_BINARY;
  console.log("PROOF_START", JSON.stringify({
    at: new Date().toISOString(), commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    ...(nativeBinary ? { nativeSha256: createHash("sha256").update(readFileSync(nativeBinary)).digest("hex") } : {}),
  }));
  await runSessionStateWidgetProof({
    live: { credentialSource },
    nativeBinary,
    outputDirectory: process.env.OO_WIDGET_PROOF_OUTPUT_DIR,
  });
  console.log("PROOF_END", new Date().toISOString());
}
