import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decorateToolForDisplay } from "pi-tool-display/tool-display-api-consumer";

const toolDisplayPackage: string = "pi-tool-display";

/** Load the public default only after OO has pointed Pi at its isolated agent directory. */
async function loadToolDisplayExtension(): Promise<ExtensionFactory> {
  return (await import(toolDisplayPackage) as { default: ExtensionFactory }).default;
}

const genericOverride = {
  enabled: true,
  kind: "generic",
  outputMode: "summary",
} as const;

/**
 * Owner Operator pins one compact package configuration under its isolated Pi agent dir.
 * Summary modes keep ordinary output quiet while preserving Pi's expanded raw-result view.
 */
function configureToolDisplay(piAgentDir: string, customToolNames: readonly string[]): string {
  const configPath = join(piAgentDir, "extensions", "pi-tool-display", "config.json");
  const config = {
    enabled: true,
    registerToolOverrides: {
      read: true,
      grep: true,
      find: true,
      ls: true,
      bash: true,
      edit: true,
      write: true,
    },
    customToolOverrides: Object.fromEntries(customToolNames.map((name) => [name, {
      ...genericOverride,
      // The durable tool result already contains the resolved run identity and task. Preview it
      // in the package-owned block instead of appending a second launch component.
      outputMode: name === "delegate_agent" ? "preview" : genericOverride.outputMode,
    }])),
    enableNativeUserMessageBox: false,
    readOutputMode: "summary",
    searchOutputMode: "count",
    mcpOutputMode: "summary",
    previewLines: 8,
    expandedPreviewMaxLines: 0,
    bashOutputMode: "summary",
    bashCollapsedLines: 10,
    diffViewMode: "auto",
    diffIndicatorMode: "bars",
    diffSplitMinWidth: 120,
    diffCollapsedLines: 24,
    diffWordWrap: true,
    showTruncationHints: false,
    showRtkCompactionHints: false,
  };
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  mkdirSync(dirname(configPath), { recursive: true });
  let current: string | undefined;
  try { current = readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== contents) writeFileSync(configPath, contents);
  return configPath;
}

/** Register cloned custom tools after the display API, using its supported consumer adapter. */
export function createOwnerOperatorToolsExtension(tools: readonly ToolDefinition[]): ExtensionFactory {
  return (pi) => {
    for (const tool of tools) {
      const decorated = decorateToolForDisplay(
        { ...tool },
        { kind: "generic", overrideExistingRenderers: true },
      );
      pi.registerTool(decorated as ToolDefinition);
    }
  };
}

/** Configure display ownership, then register OO tools through that same supported Pi API. */
export async function createOwnerOperatorToolDisplayExtension(
  piAgentDir: string,
  tools: readonly ToolDefinition[],
): Promise<ExtensionFactory> {
  configureToolDisplay(piAgentDir, tools.map((tool) => tool.name));
  const toolDisplayExtension = await loadToolDisplayExtension();
  return (pi) => {
    toolDisplayExtension(pi);
    createOwnerOperatorToolsExtension(tools)(pi);
  };
}
