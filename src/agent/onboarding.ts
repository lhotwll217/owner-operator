import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  KNOWN_SESSION_SOURCES,
  ONBOARDING_STEPS,
  addBlacklistEntries,
  detectPiConfiguration,
  detectSessionSourceCandidates,
  ensureOwnerOperatorWorkspace,
  importPiConfiguration,
  isOnboarded,
  markOnboarded,
  markOnboardingStep,
  pendingOnboardingSteps,
  saveActiveWindow,
  saveHarnessSettings,
  saveSessionRoots,
  type OnboardingStep,
  type SessionSourceCandidate,
} from "@owner-operator/core";
import {
  getAgentDir,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../shared/repo-root";

const execFileAsync = promisify(execFile);
let running = false;

export interface OnboardingFlowOptions {
  force?: boolean;
  ooHome?: string;
  piAgentDir?: string;
  platform?: NodeJS.Platform;
  detectCandidates?: (deep: boolean) => SessionSourceCandidate[];
  installAlwaysOn?: (ooHome: string) => Promise<void>;
  refreshConfiguration?: () => Promise<void>;
}

const expandHome = (value: string): string => value === "~"
  ? homedir()
  : value.startsWith("~/")
    ? path.join(homedir(), value.slice(2))
    : value;

function privacyEntries(raw: string): { paths: string[]; repos: string[] } {
  const paths: string[] = [];
  const repos: string[] = [];
  for (const value of raw.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)) {
    if (path.isAbsolute(value) || value.startsWith("~") || value.includes(path.sep)) paths.push(path.resolve(expandHome(value)));
    else repos.push(value);
  }
  return { paths, repos };
}

const installAlwaysOn = async (ooHome: string): Promise<void> => {
  await execFileAsync("make", ["install"], {
    cwd: path.join(repoRoot, "apps", "widget"),
    env: { ...process.env, OO_HOME: ooHome },
  });
};

export async function runOnboarding(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  options: OnboardingFlowOptions = {},
): Promise<boolean> {
  if (running || !ctx.hasUI) return false;
  const paths = ensureOwnerOperatorWorkspace(options.ooHome);
  if (!options.force && isOnboarded(paths.home)) return true;
  running = true;
  try {
    const pending = new Set<OnboardingStep>(options.force ? ONBOARDING_STEPS : pendingOnboardingSteps(paths.home));
    const needs = (step: OnboardingStep): boolean => pending.has(step);

    if (needs("intro")) {
      const accepted = await ctx.ui.confirm(
        "Owner Operator",
        `Owner Operator reads confirmed local agent-session roots, stores state under ${paths.home}, ` +
          "and sends bounded transcript samples to the configured model. Continue?",
      );
      if (!accepted) return false;
      markOnboardingStep(paths.home, "intro");
    }

    if (needs("privacy")) {
      const raw = await ctx.ui.input(
        "Anything off-limits?",
        "paths or repository names, comma-separated; blank for none",
      );
      addBlacklistEntries(paths.home, privacyEntries(raw ?? ""));
      markOnboardingStep(paths.home, "privacy");
    }

    if (needs("auth")) {
      const piAgentDir = options.piAgentDir ?? getAgentDir();
      const detected = detectPiConfiguration(piAgentDir);
      if (detected.auth || detected.settings || detected.models) {
        const port = await ctx.ui.confirm(
          "Import Pi setup?",
          "Copy every Pi authorization entry plus model selection and custom model settings into Owner Operator? Pi remains unchanged.",
        );
        if (port) {
          importPiConfiguration(paths.home, piAgentDir);
          await options.refreshConfiguration?.();
        }
        markOnboardingStep(paths.home, "auth", { piImport: port ? "imported" : "declined" });
      } else {
        markOnboardingStep(paths.home, "auth", { piImport: "not-found" });
      }
    }

    if (needs("session-sources")) {
      const detect = options.detectCandidates ?? ((deep: boolean) =>
        detectSessionSourceCandidates(paths.home, { deep }));
      const confirmed: Array<{ source: string; root: string }> = [];
      const offered = new Set<string>();
      const offer = async (candidate: SessionSourceCandidate): Promise<void> => {
        const key = `${candidate.source}\0${candidate.root}`;
        if (offered.has(key) || !candidate.exists || (candidate.tier === 3 && !candidate.shape)) return;
        offered.add(key);
        if (await ctx.ui.confirm(`Use ${candidate.source} sessions?`, candidate.root)) {
          confirmed.push({ source: candidate.source, root: candidate.root });
        }
      };
      for (const candidate of detect(false)) await offer(candidate);
      if (await ctx.ui.confirm("Search more locations?", "Run a bounded name-only search of your home and mounted volumes?")) {
        for (const candidate of detect(true).filter((candidate) => candidate.tier === 3)) await offer(candidate);
      }
      for (;;) {
        const source = await ctx.ui.select("Add or override a session root", ["Done", ...KNOWN_SESSION_SOURCES]);
        if (!source || source === "Done") break;
        const root = await ctx.ui.input(`Path to ${source} sessions`, "/absolute/path");
        if (root?.trim()) confirmed.push({ source, root: path.resolve(expandHome(root.trim())) });
      }
      saveSessionRoots(paths.home, confirmed);
      markOnboardingStep(paths.home, "session-sources");
    }

    if (needs("active-window")) {
      const window = await ctx.ui.select("How far back counts as active?", ["1d", "36h", "3d", "7d"]);
      saveActiveWindow(paths.home, window ?? "1d");
      markOnboardingStep(paths.home, "active-window");
    }

    if (needs("skills")) {
      const policy = await ctx.ui.select("Personal Agent Skills", [
        "Owner Operator only (recommended)",
        "All personal skills",
        "Selected personal skills",
      ]);
      if (policy === "All personal skills") {
        saveHarnessSettings(paths.home, { skillPolicy: { mode: "all-personal", allowlist: [] } });
      } else if (policy === "Selected personal skills") {
        const raw = await ctx.ui.input("Personal skill names", "calendar, mail");
        const allowlist = (raw ?? "").split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
        saveHarnessSettings(paths.home, { skillPolicy: { mode: "allowlist", allowlist } });
      } else {
        saveHarnessSettings(paths.home, { skillPolicy: { mode: "owner-operator", allowlist: [] } });
      }
      markOnboardingStep(paths.home, "skills");
    }

    if (needs("always-on")) {
      if ((options.platform ?? process.platform) === "darwin") {
        const install = await ctx.ui.confirm(
          "Keep Owner Operator running?",
          "Install the existing widget and daemon LaunchAgents for login and crash recovery?",
        );
        if (install) {
          await (options.installAlwaysOn ?? installAlwaysOn)(paths.home);
          saveHarnessSettings(paths.home, { alwaysOn: "installed" });
        } else {
          saveHarnessSettings(paths.home, { alwaysOn: "declined" });
        }
      }
      markOnboardingStep(paths.home, "always-on");
    }

    if (pendingOnboardingSteps(paths.home).length === 0) {
      markOnboarded(paths.home, { via: options.force ? "command" : "first-run" });
      ctx.ui.notify("Owner Operator setup is complete.", "info");
      return true;
    }
    return false;
  } finally {
    running = false;
  }
}

export function createOnboardingExtension(options: Omit<OnboardingFlowOptions, "force"> = {}): ExtensionFactory {
  return (pi) => {
    const activateConfiguredModel = async (ctx: ExtensionContext): Promise<void> => {
      const paths = ensureOwnerOperatorWorkspace(options.ooHome);
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(paths.piSettings, "utf8")); } catch { return; }
      const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
      const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
      if (!provider || !modelId) return;
      ctx.modelRegistry.refresh();
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model) await pi.setModel(model);
    };
    pi.registerCommand("onboarding", {
      description: "Configure Owner Operator privacy, credentials, sources, skills, and always-on services.",
      handler: async (_args, ctx) => {
        if (await runOnboarding(ctx, { ...options, force: true })) await activateConfiguredModel(ctx);
      },
    });
    pi.on("session_start", async (event, ctx) => {
      if (event.reason === "startup" && await runOnboarding(ctx, options)) await activateConfiguredModel(ctx);
    });
  };
}

export const onboardingExtension = createOnboardingExtension();
