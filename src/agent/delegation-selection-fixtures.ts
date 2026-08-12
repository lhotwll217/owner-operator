import {
  AgentRunHarness,
  isAgentRunEffort,
  type AgentRunEffort,
} from "@owner-operator/core";

export interface DelegationFixtureIdentity {
  harness: AgentRunHarness;
  model: string;
  effort: AgentRunEffort | null;
}

export interface DelegationDetailFixture {
  harness: AgentRunHarness;
  models: Array<{ id: string; reasoningLevels: AgentRunEffort[] }> | null;
  allowanceWindows: Array<{ id: string; usedPercent: number }> | null;
}

export interface DelegationBehaviorFixture {
  id: string;
  prompt: string;
  roster: string;
  details: DelegationDetailFixture[];
  reject?: { harness: AgentRunHarness; model: string; reason: string };
  expectedLaunches: DelegationFixtureIdentity[];
  bypassSelection?: boolean;
  requiresDetails?: boolean;
  requiresFallbackReport?: boolean;
  requiresOwnerQuestion?: boolean;
  requiresUnknownReport?: boolean;
}

const CASE_KEYS = new Set([
  "id", "prompt", "roster", "details", "reject", "expectedLaunches", "bypassSelection",
  "requiresDetails", "requiresFallbackReport", "requiresOwnerQuestion", "requiresUnknownReport",
]);

export function parseDelegationBehaviorFixtures(source: string): DelegationBehaviorFixture[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`delegation behavior fixture is not valid JSON: ${messageOf(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) fail("root must be a non-empty array");
  return parsed.map((entry, index) => parseCase(entry, `case[${index}]`));
}

function parseCase(value: unknown, path: string): DelegationBehaviorFixture {
  const entry = object(value, path);
  rejectUnknown(entry, CASE_KEYS, path);
  const result: DelegationBehaviorFixture = {
    id: string(entry.id, `${path}.id`),
    prompt: string(entry.prompt, `${path}.prompt`),
    roster: string(entry.roster, `${path}.roster`),
    details: array(entry.details, `${path}.details`, parseDetail),
    expectedLaunches: array(entry.expectedLaunches, `${path}.expectedLaunches`, parseIdentity),
  };
  if (result.expectedLaunches.length === 0) fail(`${path}.expectedLaunches must not be empty`);
  for (const key of ["bypassSelection", "requiresDetails", "requiresFallbackReport", "requiresOwnerQuestion", "requiresUnknownReport"] as const) {
    if (Object.hasOwn(entry, key)) result[key] = boolean(entry[key], `${path}.${key}`);
  }
  if (Object.hasOwn(entry, "reject")) {
    const rejection = object(entry.reject, `${path}.reject`);
    rejectUnknown(rejection, new Set(["harness", "model", "reason"]), `${path}.reject`);
    result.reject = {
      harness: harness(rejection.harness, `${path}.reject.harness`),
      model: string(rejection.model, `${path}.reject.model`),
      reason: string(rejection.reason, `${path}.reject.reason`),
    };
  }
  return result;
}

function parseIdentity(value: unknown, path: string): DelegationFixtureIdentity {
  const entry = object(value, path);
  rejectUnknown(entry, new Set(["harness", "model", "effort"]), path);
  if (!Object.hasOwn(entry, "effort")) fail(`${path}.effort must be explicit`);
  return {
    harness: harness(entry.harness, `${path}.harness`),
    model: string(entry.model, `${path}.model`),
    effort: effort(entry.effort, `${path}.effort`),
  };
}

function parseDetail(value: unknown, path: string): DelegationDetailFixture {
  const entry = object(value, path);
  rejectUnknown(entry, new Set(["harness", "models", "allowanceWindows"]), path);
  if (!Object.hasOwn(entry, "models") || !Object.hasOwn(entry, "allowanceWindows")) {
    fail(`${path} must explicitly define models and allowanceWindows`);
  }
  return {
    harness: harness(entry.harness, `${path}.harness`),
    models: entry.models === null ? null : array(entry.models, `${path}.models`, (model, modelPath) => {
      const item = object(model, modelPath);
      rejectUnknown(item, new Set(["id", "reasoningLevels"]), modelPath);
      return {
        id: string(item.id, `${modelPath}.id`),
        reasoningLevels: array(item.reasoningLevels, `${modelPath}.reasoningLevels`, effortNonNull),
      };
    }),
    allowanceWindows: entry.allowanceWindows === null ? null : array(
      entry.allowanceWindows,
      `${path}.allowanceWindows`,
      (window, windowPath) => {
        const item = object(window, windowPath);
        rejectUnknown(item, new Set(["id", "usedPercent"]), windowPath);
        const usedPercent = number(item.usedPercent, `${windowPath}.usedPercent`);
        if (usedPercent < 0 || usedPercent > 100) fail(`${windowPath}.usedPercent must be between 0 and 100`);
        return { id: string(item.id, `${windowPath}.id`), usedPercent };
      },
    ),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function array<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${path} must be a non-empty string`);
  return value;
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}
function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}
function harness(value: unknown, path: string): AgentRunHarness {
  if (!Object.values(AgentRunHarness).includes(value as AgentRunHarness)) fail(`${path} is not a supported harness`);
  return value as AgentRunHarness;
}
function effort(value: unknown, path: string): AgentRunEffort | null {
  if (value !== null && !isAgentRunEffort(value)) fail(`${path} is not a supported effort or null`);
  return value as AgentRunEffort | null;
}
function effortNonNull(value: unknown, path: string): AgentRunEffort {
  if (!isAgentRunEffort(value)) fail(`${path} is not a supported effort`);
  return value;
}
function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`${path} has unknown field(s): ${unknown.join(", ")}`);
}
function fail(message: string): never { throw new Error(`malformed delegation behavior fixture: ${message}`); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
