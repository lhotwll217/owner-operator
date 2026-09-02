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

export type ThoughtLevelSelectorResolution =
  | { kind: "found"; selector: Extract<SessionConfigOption, { type: "select" }> }
  | { kind: "missing" }
  | { kind: "ambiguous"; detail: string };

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

/** One category-first, bounded-fallback policy shared by delegated launch and snapshot baseline
 * projection. The caller decides whether missing/ambiguous state is fatal for its own contract. */
export function resolveThoughtLevelSelector(
  options: SessionConfigOption[],
): ThoughtLevelSelectorResolution {
  const selectOptions = options.filter(
    (option): option is Extract<SessionConfigOption, { type: "select" }> => option.type === "select",
  );
  const categorized = selectOptions.filter(({ category }) => category === THOUGHT_LEVEL_CATEGORY);
  if (categorized.length > 1) {
    return { kind: "ambiguous", detail: "thought-level category matched multiple options" };
  }
  if (categorized.length === 1) return { kind: "found", selector: categorized[0]! };

  for (const id of THOUGHT_LEVEL_FALLBACK_IDS) {
    const matching = selectOptions.filter((option) => option.id === id);
    if (matching.length > 1) {
      return {
        kind: "ambiguous",
        detail: `fallback option ${JSON.stringify(id)} matched multiple selectors`,
      };
    }
    if (matching.length === 1) return { kind: "found", selector: matching[0]! };
  }
  return { kind: "missing" };
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
  const resolution = resolveThoughtLevelSelector(options);
  if (resolution.kind === "ambiguous") {
    throw failure("ACP_SELECTION_SELECTOR_AMBIGUOUS", requested, `${phase} ${resolution.detail}`);
  }
  if (resolution.kind === "found") return resolution.selector;
  throw failure("ACP_SELECTION_SELECTOR_MISSING", requested, `${phase} status advertised no thought-level selector`);
}

/** Validate only what this service consumes: select discrimination, id, category, currentValue,
 * and the advertised select values. Everything else on an option — names, descriptions, _meta,
 * non-select option shapes, future extensions — is opaque and passes through unchanged. */
function validateConfigOption(value: unknown, index: number): void {
  const option = record(value);
  if (!option) throw invalid(index, "must be an object");
  if (option.type !== "select") return;
  if (typeof option.id !== "string" || !option.id.trim()) throw invalid(index, "select id must be a non-empty string");
  if (option.category !== undefined && option.category !== null && typeof option.category !== "string") {
    throw invalid(index, "select category must be a string or null");
  }
  if (typeof option.currentValue !== "string") throw invalid(index, "select currentValue must be a string");
  if (!Array.isArray(option.options)) throw invalid(index, "select options must be an array");
  for (const [choiceIndex, choiceValue] of option.options.entries()) {
    const choice = record(choiceValue);
    if (!choice) throw invalid(index, `choice ${choiceIndex} must be an object`);
    if (Object.hasOwn(choice, "value")) {
      if (typeof choice.value !== "string") throw invalid(index, `choice ${choiceIndex} value must be a string`);
      continue;
    }
    if (!Array.isArray(choice.options)) throw invalid(index, `group ${choiceIndex} options must be an array`);
    for (const [groupedIndex, groupedValue] of choice.options.entries()) {
      const grouped = record(groupedValue);
      if (!grouped || typeof grouped.value !== "string") {
        throw invalid(index, `group ${choiceIndex} choice ${groupedIndex} value must be a string`);
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
