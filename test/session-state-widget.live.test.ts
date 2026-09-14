import { runSessionStateWidgetProof } from "./session-state-widget-proof";

if (process.env.OO_WIDGET_PROOF_LIVE !== "1") {
  console.log("skip - set OO_WIDGET_PROOF_LIVE=1 for paid Luna-medium widget proof");
} else {
  const credentialSource = process.env.OO_WIDGET_PROOF_CREDENTIAL_SOURCE;
  if (!credentialSource) throw new Error("live proof requires an explicit credential source directory");
  await runSessionStateWidgetProof({
    live: { credentialSource },
    nativeBinary: process.env.OO_WIDGET_PROOF_NATIVE_BINARY,
    outputDirectory: process.env.OO_WIDGET_PROOF_OUTPUT_DIR,
  });
}
