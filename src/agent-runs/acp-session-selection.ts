import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "acpx/runtime";
import type { AgentRunEffort } from "@owner-operator/core";

const THOUGHT_LEVEL_CATEGORY = "thought_level";
const THOUGHT_LEVEL_FALLBACK_IDS = ["thought_level", "reasoning_effort"] as const;

export const ACP_CONFIG_OPTIONS_INVALID = "ACP_CONFIG_OPTIONS_INVALID";

export interface RequestedAcpSelection {
  model: string;
  effort: AgentRunEffort | null;
}

export interface ConfirmedAcpSelection {
  model: string;
  effort?: AgentRunEffort;
  configOptions: SessionConfigOption[];
}

/** A blocking selection failure. The requested identity stays in both structured fields and the
 * persisted error message, while the ACP adapter's lower-level failure remains available as cause. */
export class AcpSelectionConfirmationError extends Error {
  readonly code: string;
  readonly requested: RequestedAcpSelection;

  constructor(
    code: string,
    requested: RequestedAcpSelection,
    detail: string,
    options: { cause?: unknown } = {},
  ) {
    super(
      `${code}: ACP selection confirmation failed for model=${JSON.stringify(requested.model)} `
      + `effort=${requested.effort === null ? "null" : JSON.stringify(requested.effort)}: ${detail}`,
      options,
    );
    this.name = "AcpSelectionConfirmationError";
    this.code = code;
    this.requested = requested;
  }
}

class AcpConfigOptionsInvalidError extends Error {
  readonly code = ACP_CONFIG_OPTIONS_INVALID;

  constructor(detail: string) {
    super(`${ACP_CONFIG_OPTIONS_INVALID}: ${detail}`);
    this.name = "AcpConfigOptionsInvalidError";
  }
}

/** Decode only the ACP option structure this service consumes. Accepted option objects are
 * returned unchanged so callers retain names, descriptions, metadata, and future extensions. */
export function configOptionsFromStatus(status: AcpRuntimeStatus): SessionConfigOption[] | null {
  const details = status.details;
  if (!details || !Object.hasOwn(details, "configOptions")) return null;
  const payload = details.configOptions;
  if (!Array.isArray(payload)) {
    throw new AcpConfigOptionsInvalidError("status.details.configOptions must be an array when present");
  }
  for (const [index, value] of payload.entries()) validateConfigOption(value, index);
  return payload as SessionConfigOption[];
}

/** Preserve exact advertised values while flattening ACP's direct and grouped select choices. */
export function advertisedSelectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => {
    if ("value" in entry) return [entry.value];
    return entry.options.map(({ value }) => value);
  });
}

/** Establish the exact requested model and nullable effort on one live ACP session, then prove
 * the effective state from a fresh status snapshot before any task turn may start. */
export async function applyAndConfirmAcpSelection(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  requested: RequestedAcpSelection,
): Promise<ConfirmedAcpSelection> {
  try {
    if (!runtime.getStatus) {
      throw failure("ACP_SELECTION_STATUS_UNAVAILABLE", requested, "runtime does not expose session status");
    }
    const initialStatus = await runtime.getStatus({ handle });
    requireExactModel(initialStatus, requested, "initial");
    const initialOptions = requireConfigOptions(initialStatus, requested, "initial");

    if (requested.effort === null) {
      return { model: requested.model, configOptions: initialOptions };
    }

    const selector = requireThoughtLevelSelector(initialOptions, requested, "initial");
    if (!advertisedSelectValues(selector).includes(requested.effort)) {
      throw failure(
        "ACP_SELECTION_EFFORT_UNAVAILABLE",
        requested,
        `option ${JSON.stringify(selector.id)} does not advertise requested effort`,
      );
    }
    if (!runtime.setConfigOption) {
      throw failure("ACP_SELECTION_SET_UNAVAILABLE", requested, "runtime does not expose config-option setting");
    }

    await runtime.setConfigOption({ handle, key: selector.id, value: requested.effort });

    // Exactly one post-set refresh is authoritative. Setter acknowledgement is never evidence.
    const confirmedStatus = await runtime.getStatus({ handle });
    requireExactModel(confirmedStatus, requested, "confirmed");
    const confirmedOptions = requireConfigOptions(confirmedStatus, requested, "confirmed");
    const confirmedSelector = requireThoughtLevelSelector(confirmedOptions, requested, "confirmed");
    if (confirmedSelector.id !== selector.id) {
      throw failure(
        "ACP_SELECTION_SELECTOR_CHANGED",
        requested,
        `thought-level option changed from ${JSON.stringify(selector.id)} to ${JSON.stringify(confirmedSelector.id)}`,
      );
    }
    if (!advertisedSelectValues(confirmedSelector).includes(requested.effort)) {
      throw failure(
        "ACP_SELECTION_EFFORT_UNAVAILABLE",
        requested,
        `confirmed option ${JSON.stringify(confirmedSelector.id)} no longer advertises requested effort`,
      );
    }
    if (confirmedSelector.currentValue !== requested.effort) {
      throw failure(
        "ACP_SELECTION_EFFORT_MISMATCH",
        requested,
        `confirmed effort was ${JSON.stringify(confirmedSelector.currentValue)}`,
      );
    }
    return {
      model: requested.model,
      effort: requested.effort,
      configOptions: confirmedOptions,
    };
  } catch (error) {
    if (error instanceof AcpSelectionConfirmationError) throw error;
    if (error instanceof AcpConfigOptionsInvalidError) {
      throw failure(error.code, requested, error.message, error);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw failure("ACP_SELECTION_CONFIRMATION_FAILED", requested, detail, error);
  }
}

function requireExactModel(
  status: AcpRuntimeStatus,
  requested: RequestedAcpSelection,
  phase: "initial" | "confirmed",
): void {
  const model = status.models?.currentModelId;
  if (model !== requested.model) {
    throw failure(
      "ACP_SELECTION_MODEL_MISMATCH",
      requested,
      `${phase} model was ${model === undefined ? "missing" : JSON.stringify(model)}`,
    );
  }
}

function requireConfigOptions(
  status: AcpRuntimeStatus,
  requested: RequestedAcpSelection,
  phase: "initial" | "confirmed",
): SessionConfigOption[] {
  const options = configOptionsFromStatus(status);
  if (options === null) {
    throw failure("ACP_SELECTION_CONFIG_OPTIONS_MISSING", requested, `${phase} configOptions were missing`);
  }
  return options;
}

function requireThoughtLevelSelector(
  options: SessionConfigOption[],
  requested: RequestedAcpSelection,
  phase: "initial" | "confirmed",
): Extract<SessionConfigOption, { type: "select" }> {
  const categorized = selectOptions(options).filter(({ category }) => category === THOUGHT_LEVEL_CATEGORY);
  if (categorized.length > 1) {
    throw failure("ACP_SELECTION_SELECTOR_AMBIGUOUS", requested, `${phase} thought-level category matched multiple options`);
  }
  if (categorized.length === 1) return categorized[0]!;

  for (const id of THOUGHT_LEVEL_FALLBACK_IDS) {
    const matching = selectOptions(options).filter((option) => option.id === id);
    if (matching.length > 1) {
      throw failure(
        "ACP_SELECTION_SELECTOR_AMBIGUOUS",
        requested,
        `${phase} fallback option ${JSON.stringify(id)} matched multiple selectors`,
      );
    }
    if (matching.length === 1) return matching[0]!;
  }
  throw failure("ACP_SELECTION_SELECTOR_MISSING", requested, `${phase} status advertised no thought-level selector`);
}

function selectOptions(
  options: SessionConfigOption[],
): Array<Extract<SessionConfigOption, { type: "select" }>> {
  return options.filter(
    (option): option is Extract<SessionConfigOption, { type: "select" }> => option.type === "select",
  );
}

function validateConfigOption(value: unknown, index: number): void {
  const option = record(value);
  if (!option) throw invalid(index, "must be an object");
  if (typeof option.id !== "string" || !option.id.trim()) throw invalid(index, "id must be a non-empty string");
  if (option.category !== undefined && option.category !== null && typeof option.category !== "string") {
    throw invalid(index, "category must be a string or null");
  }
  if (option.type === "boolean") {
    if (typeof option.currentValue !== "boolean") throw invalid(index, "boolean currentValue must be boolean");
    return;
  }
  if (option.type !== "select") throw invalid(index, "type must be select or boolean");
  if (typeof option.currentValue !== "string") throw invalid(index, "select currentValue must be a string");
  if (!Array.isArray(option.options)) throw invalid(index, "select options must be an array");
  for (const [choiceIndex, value] of option.options.entries()) {
    const choice = record(value);
    if (!choice) throw invalid(index, `choice ${choiceIndex} must be an object`);
    if (typeof choice.value === "string") continue;
    if (!Array.isArray(choice.options)) throw invalid(index, `choice ${choiceIndex} has no value or group options`);
    for (const [nestedIndex, nestedValue] of choice.options.entries()) {
      const nested = record(nestedValue);
      if (!nested || typeof nested.value !== "string") {
        throw invalid(index, `group ${choiceIndex} choice ${nestedIndex} must have a string value`);
      }
    }
  }
}

function invalid(index: number, detail: string): AcpConfigOptionsInvalidError {
  return new AcpConfigOptionsInvalidError(`config option ${index} ${detail}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failure(
  code: string,
  requested: RequestedAcpSelection,
  detail: string,
  cause?: unknown,
): AcpSelectionConfirmationError {
  return new AcpSelectionConfirmationError(code, requested, detail, cause === undefined ? {} : { cause });
}
