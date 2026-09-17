// Redaction has to leave a capture usable as the same artifact: every position identical, only
// the secret gone. These inputs are invented, never taken from a capture.
import assert from "node:assert/strict";
import { redactCredentials, scanCredentials } from "./credentials.mjs";

const transcript = [
  JSON.stringify({ type: "message", text: "callback https://id.example.com/connect?code=A1B2C3D4E5F6A7B8C9D0&id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk" }),
  JSON.stringify({ type: "message", text: "const headers = { authorization: 'Bearer startup-private-token' };" }),
  JSON.stringify({ type: "message", text: "export ANTHROPIC_API_KEY=sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE1234" }),
  JSON.stringify({ type: "message", text: "no secret here, only the words code and bearer" }),
].join("\n");

const { text, counts } = redactCredentials(transcript);

assert.equal(text.length, transcript.length, "a redacted capture keeps every byte position");
assert.equal(text.split("\n").length, transcript.split("\n").length, "line count is unchanged");
for (const line of text.split("\n")) JSON.parse(line);
// The id_token value is claimed by the more specific json-web-token pattern, leaving the
// authorization code as the one oauth-parameter match.
assert.deepEqual(counts, { "api-key": 1, "json-web-token": 1, "oauth-parameter": 1, "bearer-token": 1 });
assert.deepEqual(scanCredentials(text), {}, "nothing matches any pattern afterwards");

assert.ok(text.includes("callback https://id.example.com/connect?code="), "the URL and its parameter names survive");
assert.ok(text.includes("const headers = { authorization: 'Bearer "), "the code around a token survives");
assert.ok(text.includes("no secret here, only the words code and bearer"), "text without a value is untouched");
assert.ok(!text.includes("A1B2C3D4E5F6A7B8C9D0") && !text.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "values are gone");
assert.ok(text.includes("[redacted-json-web-token]"), "a reader can tell a value was removed");

// Redaction is idempotent: a placeholder is not itself a credential, so a second pass is a no-op.
assert.deepEqual(redactCredentials(text).counts, {}, "re-running finds nothing to redact");

process.stdout.write("ok — credential redaction preserves positions, structure, and surrounding evidence\n");
