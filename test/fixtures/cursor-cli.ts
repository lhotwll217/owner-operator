/** Payloads captured verbatim from the first-party `cursor-agent` CLI (2026.07.08): the JSON
 * results of `about --format json` and `status --format json`, and the `models` object from a
 * live `cursor-agent acp` session/new response (truncated to a representative slice). Only the
 * account email and user identity fields are replaced.
 *
 * Regenerate by running those commands / the ACP initialize+session/new handshake against a
 * signed-in `cursor-agent` and pasting the raw output; do not hand-edit field shapes, because
 * these fixtures exist to prove Owner Operator normalizes the surfaces as they actually are.
 */

/** Raw `cursor-agent about --format json` stdout for a signed-in subscription account. */
export const CURSOR_ABOUT = {
  "cliVersion": "2026.07.08-0c04a8a",
  "model": "Fable 5 300K High",
  "subscriptionTier": "Pro",
  "osPlatform": "darwin",
  "osArch": "arm64",
  "userEmail": "owner@example.com",
  "terminalProgram": "unknown",
  "shell": "zsh",
  "lastRequestId": null
} as const;

/** Raw `cursor-agent status --format json` stdout for the same signed-in account. */
export const CURSOR_STATUS = {
  "status": "authenticated",
  "isAuthenticated": true,
  "hasAccessToken": true,
  "hasRefreshToken": true,
  "userInfo": {
    "email": "owner@example.com",
    "userId": 10000001,
    "firstName": "Owner",
    "lastName": "Example"
  }
} as const;

/** Raw `models` object from a `cursor-agent acp` session/new result: the launch-authoritative
 * catalog. Ids are bracket-parameterized and differ from the broader `cursor-agent models`
 * account catalog; `currentModelId` is what an unpinned session selected. */
export const CURSOR_ACP_MODELS = {
  "currentModelId": "claude-fable-5[thinking=true,context=300k,effort=high]",
  "availableModels": [
    { "modelId": "default[]", "name": "Auto" },
    { "modelId": "grok-4.6[effort=high,fast=true]", "name": "grok-4.6" },
    { "modelId": "composer-2.5[fast=true]", "name": "composer-2.5" },
    { "modelId": "claude-opus-5[thinking=true,context=300k,effort=high,fast=false]", "name": "claude-opus-5" },
    { "modelId": "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]", "name": "gpt-5.6-sol" },
    { "modelId": "claude-fable-5[thinking=true,context=300k,effort=high]", "name": "claude-fable-5" },
    { "modelId": "claude-sonnet-5[thinking=true,context=300k,effort=high]", "name": "claude-sonnet-5" },
    { "modelId": "gemini-3.1-pro[]", "name": "gemini-3.1-pro" },
  ],
} as const;
