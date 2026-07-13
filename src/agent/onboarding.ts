import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  KNOWN_AGENT_HARNESSES,
  KNOWN_SESSION_HOSTS,
  ONBOARDING_STEPS,
  REVIEWED_SESSION_HOSTS,
  addBlacklistEntries,
  detectPiConfiguration,
  detectSessionHostCandidates,
  detectSessionSourceCandidates,
  ensureOwnerOperatorWorkspace,
  importPiConfiguration,
  isOnboarded,
  loadPiImportDecision,
  loadTranscriptAccess,
  markOnboarded,
  markOnboardingStep,
  pendingOnboardingSteps,
  saveActiveWindow,
  saveHarnessSettings,
  saveSessionHostRoots,
  saveTranscriptAccess,
  recordPiImportDecision,
  type OnboardingStep,
  type SessionHostCandidate,
  type SessionSourceCandidate,
} from "@owner-operator/core";
import {
  getAgentDir,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../shared/repo-root";
import {
  buildSessionCatalogReview,
  reviewSessionCatalog,
  type SessionCatalogReview,
  type SessionCatalogReviewResult,
} from "./session-catalog-review";

const execFileAsync = promisify(execFile);
let running = false;

export interface OnboardingFlowOptions {
  force?: boolean;
  ooHome?: string;
  piAgentDir?: string;
  platform?: NodeJS.Platform;
  detectCandidates?: (deep: boolean) => SessionSourceCandidate[];
  detectHosts?: () => Promise<SessionHostCandidate[]> | SessionHostCandidate[];
  reviewCatalog?: (catalog: SessionCatalogReview) => Promise<SessionCatalogReviewResult | undefined>;
  resolveModel?: (provider: string, model: string) => boolean;
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
  ctx: Pick<ExtensionContext, "hasUI" | "ui"> & Partial<Pick<ExtensionContext, "mode" | "modelRegistry">>,
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
        "Are there any coding projects or repositories you don’t want Owner Operator to interact with?",
        "paths or repository names, comma-separated; blank for none",
      );
      addBlacklistEntries(paths.home, privacyEntries(raw ?? ""));
      markOnboardingStep(paths.home, "privacy");
    }

    if (needs("auth")) {
      const piAgentDir = options.piAgentDir ?? getAgentDir();
      const detected = detectPiConfiguration(piAgentDir);
      const priorImportDecision = loadPiImportDecision(paths.home);
      let piImport: "imported" | "declined" | "owned" = priorImportDecision ?? "owned";
      const externalPi = path.resolve(piAgentDir) !== path.resolve(paths.piAgentDir);
      let owned = detectPiConfiguration(paths.piAgentDir);
      const selectedModel = (): { provider: string; model: string } => {
        let configured: Record<string, unknown> = {};
        try { configured = JSON.parse(readFileSync(paths.piSettings, "utf8")); } catch { /* missing or invalid */ }
        return {
          provider: typeof configured.defaultProvider === "string" ? configured.defaultProvider : "",
          model: typeof configured.defaultModel === "string" ? configured.defaultModel : "",
        };
      };
      const ownedSelectionReady = (): boolean => {
        const selection = selectedModel();
        const registryModel = ctx.modelRegistry?.find(selection.provider, selection.model);
        if (!selection.provider || !selection.model) return false;
        return ctx.modelRegistry
          ? Boolean(registryModel && ctx.modelRegistry.hasConfiguredAuth(registryModel))
          : owned.selectedModelAuthorized;
      };
      const canOfferImport = !priorImportDecision || options.force;
      if (!ownedSelectionReady() && canOfferImport && externalPi && (detected.auth || detected.settings || detected.models)) {
        const port = await ctx.ui.confirm(
          "Import existing standalone Pi setup?",
          "Copy its authorization entries, model selection, and custom model settings into Owner Operator? Standalone Pi remains unchanged.",
        );
        if (port) {
          importPiConfiguration(paths.home, piAgentDir);
          await options.refreshConfiguration?.();
        }
        piImport = port ? "imported" : "declined";
        recordPiImportDecision(paths.home, piImport);
        owned = detectPiConfiguration(paths.piAgentDir);
      }
      const hasOwnedAuthorization = ctx.modelRegistry
        ? ctx.modelRegistry.getAvailable().length > 0
        : owned.auth;
      if (!owned.selectedModel && !hasOwnedAuthorization) {
        ctx.ui.notify("A model provider is required. Complete Owner Operator’s built-in provider login, then run /onboarding to continue.", "warning");
        ctx.ui.setEditorText("/login");
        return false;
      }
      if (!owned.selectedModel) {
        ctx.ui.notify("Choose the model Owner Operator should use, then run /onboarding to continue.", "warning");
        ctx.ui.setEditorText("/model");
        return false;
      }
      const { provider, model } = selectedModel();
      const registryModel = ctx.modelRegistry?.find(provider, model);
      const resolves = options.resolveModel?.(provider, model) ?? Boolean(registryModel);
      if (!resolves) {
        ctx.ui.notify("The configured model is unavailable. Choose a model from Owner Operator’s built-in picker, then run /onboarding to continue.", "warning");
        ctx.ui.setEditorText("/model");
        return false;
      }
      const authorized = registryModel
        ? Boolean(ctx.modelRegistry?.hasConfiguredAuth(registryModel))
        : Boolean(options.resolveModel && owned.selectedModelAuthorized);
      if (!authorized) {
        ctx.ui.notify("The selected model provider still needs authorization. Complete Owner Operator’s built-in provider login, then run /onboarding to continue.", "warning");
        ctx.ui.setEditorText("/login");
        return false;
      }
      markOnboardingStep(paths.home, "auth", { piImport });
    }

    if (needs("session-sources")) {
      const detect = options.detectCandidates ?? ((deep: boolean) =>
        detectSessionSourceCandidates(paths.home, { deep }));
      const sourceCandidates = detect(false);
      const hostCandidates = await (options.detectHosts?.() ?? detectSessionHostCandidates(paths.home));
      const access = loadTranscriptAccess(paths.home);
      const catalog = buildSessionCatalogReview(sourceCandidates, hostCandidates, access.selectedFormats, access.defaultFormats);
      const reviewed = options.reviewCatalog
        ? await options.reviewCatalog(catalog)
        : await reviewSessionCatalog(ctx, catalog, {
          searchMore: async () => buildSessionCatalogReview(detect(true), hostCandidates),
        });
      if (!reviewed) return false;
      saveTranscriptAccess(paths.home, reviewed.selectedFormats, reviewed.roots, reviewed.defaultFormats);
      saveSessionHostRoots(paths.home, hostCandidates
        .filter((candidate): candidate is SessionHostCandidate & { root: string } =>
          KNOWN_SESSION_HOSTS.includes(candidate.host as typeof KNOWN_SESSION_HOSTS[number]) &&
          typeof candidate.root === "string" &&
          candidate.exists)
        .map(({ host, root }) => ({ host, root })));
      markOnboardingStep(paths.home, "session-sources", {
        reviewedHarnesses: [...KNOWN_AGENT_HARNESSES],
        reviewedSessionHosts: [...REVIEWED_SESSION_HOSTS],
      });
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
      description: "Configure Owner Operator privacy, model, session access, skills, and always-on services.",
      handler: async (_args, ctx) => {
        if (await runOnboarding(ctx, { ...options, force: isOnboarded(options.ooHome) })) await activateConfiguredModel(ctx);
      },
    });
    pi.on("session_start", async (event, ctx) => {
      if (event.reason === "startup" && await runOnboarding(ctx, options)) await activateConfiguredModel(ctx);
    });
  };
}

export const onboardingExtension = createOnboardingExtension();
