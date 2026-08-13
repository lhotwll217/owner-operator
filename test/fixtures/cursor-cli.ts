/** Payloads captured verbatim from the first-party `cursor-agent` CLI (2026.07.08): the JSON
 * results of `about --format json` and `status --format json`, and the plain-text stdout of
 * `models` (truncated to a representative slice; the real catalog is ~200 entries in the same
 * line shape). Only the account email and user identity fields are replaced.
 *
 * Regenerate by running those exact commands against a signed-in `cursor-agent` and pasting the
 * raw output; do not hand-edit field shapes, because these fixtures exist to prove Owner Operator
 * normalizes the CLI surface as it actually is.
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

/** Raw `cursor-agent models` stdout: a header, `<id> - <display name>` lines with the harness
 * default marked `(default)`, and a trailing usage tip. */
export const CURSOR_MODELS_TEXT = `Available models

auto - Auto (default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex - Codex 5.3
gpt-5.3-codex-high - Codex 5.3 High
gpt-5.3-codex-xhigh - Codex 5.3 Extra High
composer-2.5 - Composer 2.5
claude-opus-5-thinking-high - Opus 5 1M Thinking
gpt-5.6-sol-high - GPT-5.6 Sol 1M High
gpt-5.6-sol-xhigh - GPT-5.6 Sol 1M Extra High
claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)
claude-sonnet-5-thinking-high - Sonnet 5 1M Thinking
cursor-grok-4.6-high - Cursor Grok 4.6
kimi-k3-high - Kimi K3 High
glm-5.2-max - GLM 5.2 Max

Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.
`;
