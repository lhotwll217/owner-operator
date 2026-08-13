/** Payloads captured verbatim from a first-party `codex app-server` process (codex-cli 0.145.0)
 * over one `initialize` + `initialized` handshake followed by `account/read`,
 * `account/rateLimits/read`, and `model/list`. Only the account email is replaced.
 *
 * Regenerate by replaying that exact request order against `codex app-server` and pasting the
 * raw JSON-RPC results; do not hand-edit field shapes, because these fixtures exist to prove
 * Owner Operator normalizes the protocol as it actually is.
 */

/** Raw `account/read` result for a signed-in ChatGPT subscription account. */
export const CODEX_ACCOUNT_READ = {
  "account": {
    "type": "chatgpt",
    "email": "owner@example.com",
    "planType": "prolite"
  },
  "requiresOpenaiAuth": true
} as const;

/** Raw `account/rateLimits/read` result carrying one multi-bucket allowance view. */
export const CODEX_RATE_LIMITS_READ = {
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "primary": {
      "usedPercent": 9,
      "windowDurationMins": 10080,
      "resetsAt": 1787129876
    },
    "secondary": null,
    "credits": {
      "hasCredits": false,
      "unlimited": false,
      "balance": "0"
    },
    "individualLimit": null,
    "planType": "prolite",
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": {
    "codex_bengalfox": {
      "limitId": "codex_bengalfox",
      "limitName": "GPT-5.3-Codex-Spark",
      "primary": {
        "usedPercent": 0,
        "windowDurationMins": 10080,
        "resetsAt": 1787150352
      },
      "secondary": null,
      "credits": null,
      "individualLimit": null,
      "planType": "prolite",
      "rateLimitReachedType": null
    },
    "codex": {
      "limitId": "codex",
      "limitName": null,
      "primary": {
        "usedPercent": 9,
        "windowDurationMins": 10080,
        "resetsAt": 1787129876
      },
      "secondary": null,
      "credits": {
        "hasCredits": false,
        "unlimited": false,
        "balance": "0"
      },
      "individualLimit": null,
      "planType": "prolite",
      "rateLimitReachedType": null
    }
  },
  "rateLimitResetCredits": {
    "availableCount": 0
  }
} as const;

/** Raw `model/list` result: one page of the advertised catalog. */
export const CODEX_MODEL_LIST = {
  "data": [
    {
      "id": "gpt-5.6-sol",
      "model": "gpt-5.6-sol",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.6-Sol",
      "description": "Latest frontier agentic coding model.",
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "max",
          "description": "Maximum reasoning depth for the hardest problems"
        },
        {
          "reasoningEffort": "ultra",
          "description": "Maximum reasoning with automatic task delegation"
        }
      ],
      "defaultReasoningEffort": "low",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": false,
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "isDefault": true
    },
    {
      "id": "gpt-5.5",
      "model": "gpt-5.5",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.5",
      "description": "Frontier model for complex coding, research, and real-world work.",
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": true,
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "isDefault": false
    },
    {
      "id": "gpt-5.4",
      "model": "gpt-5.4",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.4",
      "description": "Strong model for everyday coding.",
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": true,
      "additionalSpeedTiers": [
        "fast"
      ],
      "serviceTiers": [
        {
          "id": "priority",
          "name": "Fast",
          "description": "1.5x speed, increased usage"
        }
      ],
      "defaultServiceTier": null,
      "isDefault": false
    },
    {
      "id": "gpt-5.4-mini",
      "model": "gpt-5.4-mini",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.4-Mini",
      "description": "Small, fast, and cost-efficient model for simpler coding tasks.",
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        }
      ],
      "defaultReasoningEffort": "medium",
      "inputModalities": [
        "text",
        "image"
      ],
      "supportsPersonality": true,
      "additionalSpeedTiers": [],
      "serviceTiers": [],
      "defaultServiceTier": null,
      "isDefault": false
    },
    {
      "id": "gpt-5.3-codex-spark",
      "model": "gpt-5.3-codex-spark",
      "upgrade": null,
      "upgradeInfo": null,
      "availabilityNux": null,
      "displayName": "GPT-5.3-Codex-Spark",
      "description": "Ultra-fast coding model.",
      "hidden": false,
      "supportedReasoningEfforts": [
        {
          "reasoningEffort": "low",
          "description": "Fast responses with lighter reasoning"
        },
        {
          "reasoningEffort": "medium",
          "description": "Balances speed and reasoning depth for everyday tasks"
        },
        {
          "reasoningEffort": "high",
          "description": "Greater reasoning depth for complex problems"
        },
        {
          "reasoningEffort": "xhigh",
          "description": "Extra high reasoning depth for complex problems"
        }
      ],
      "defaultReasoningEffort": "high",
      "inputModalities": [
        "text"
      ],
      "supportsPersonality": true,
      "additionalSpeedTiers": [],
      "serviceTiers": [],
      "defaultServiceTier": null,
      "isDefault": false
    }
  ],
  "nextCursor": null
} as const;
