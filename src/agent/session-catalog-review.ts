import {
  AGENT_HARNESS_DESCRIPTORS,
  SESSION_HOST_DESCRIPTORS,
  type SessionHostCandidate,
  type SessionSourceCandidate,
  type TranscriptFormat,
} from "@owner-operator/core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface HarnessReviewRow {
  id: string;
  label: string;
  format: TranscriptFormat;
  roots: string[];
  standardRoots: string[];
  explicitRoots: string[];
  detectedRoots: string[];
  detected: boolean;
  selected: boolean;
  defaultsEnabled: boolean;
}

export interface HostReviewRow {
  id: string;
  label: string;
  roots: string[];
  detected: boolean;
}

export interface SessionCatalogReview {
  harnesses: HarnessReviewRow[];
  hosts: HostReviewRow[];
}

export interface SessionCatalogReviewResult {
  selectedFormats: TranscriptFormat[];
  defaultFormats: TranscriptFormat[];
  roots: Array<{ format: TranscriptFormat; root: string }>;
}

export interface SessionCatalogReviewOptions {
  searchMore?: () => Promise<SessionCatalogReview>;
  pathExists?: (root: string) => boolean;
}

const resultFrom = (
  catalog: SessionCatalogReview,
  enabled: Set<TranscriptFormat>,
  defaultsEnabled: Set<TranscriptFormat>,
): SessionCatalogReviewResult => ({
  selectedFormats: catalog.harnesses.map(({ format }) => format).filter((format) => enabled.has(format)),
  defaultFormats: catalog.harnesses.map(({ format }) => format).filter((format) => enabled.has(format) && defaultsEnabled.has(format)),
  roots: catalog.harnesses.flatMap(({ format, explicitRoots }) => enabled.has(format)
    ? explicitRoots.map((root) => ({ format, root }))
    : []),
});

export function buildSessionCatalogReview(
  sourceCandidates: SessionSourceCandidate[],
  hostCandidates: SessionHostCandidate[],
  selectedFormats: readonly TranscriptFormat[] = AGENT_HARNESS_DESCRIPTORS.map(({ transcriptFormat }) => transcriptFormat),
  defaultFormats: readonly TranscriptFormat[] = selectedFormats,
): SessionCatalogReview {
  const selected = new Set(selectedFormats);
  const defaultsEnabled = new Set(defaultFormats);
  return {
    harnesses: AGENT_HARNESS_DESCRIPTORS.map((descriptor) => {
      const candidates = sourceCandidates.filter((candidate) => candidate.source === descriptor.transcriptFormat);
      return {
        id: descriptor.id,
        label: descriptor.label,
        format: descriptor.transcriptFormat,
        roots: [...new Set(candidates.map(({ root }) => root).filter((root): root is string => typeof root === "string"))],
        standardRoots: [...new Set(candidates.filter(({ tier }) => tier === 2).map(({ root }) => root))],
        explicitRoots: [...new Set(candidates.filter(({ tier }) => tier !== 2).map(({ root }) => root))],
        detectedRoots: [...new Set(candidates.filter(({ exists }) => exists).map(({ root }) => root))],
        detected: candidates.some(({ exists }) => exists),
        selected: selected.has(descriptor.transcriptFormat),
        defaultsEnabled: defaultsEnabled.has(descriptor.transcriptFormat),
      };
    }),
    hosts: SESSION_HOST_DESCRIPTORS.filter(({ review }) => review).map((descriptor) => {
      const candidates = hostCandidates.filter((candidate) => candidate.host === descriptor.id);
      return {
        id: descriptor.id,
        label: descriptor.label,
        roots: [...new Set(candidates.map(({ root }) => root).filter((root): root is string => typeof root === "string"))],
        detected: candidates.some(({ exists }) => exists),
      };
    }),
  };
}

/** One review surface: harness access is checked by default; hosts are attribution evidence. */
export async function reviewSessionCatalog(
  ctx: Pick<ExtensionContext, "ui"> & Partial<Pick<ExtensionContext, "mode">>,
  catalog: SessionCatalogReview,
  options: SessionCatalogReviewOptions = {},
): Promise<SessionCatalogReviewResult | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    const inventory = [
      "Supported agent harnesses (new harnesses are included by default; existing ignores are preserved):",
      "Included means Owner Operator may read the listed standard and detected transcript stores, including a standard path created later.",
      ...catalog.harnesses.map((row) => `- ${row.selected ? "included" : "ignored"} — ${row.id}: ${row.label}${row.detected ? " (detected)" : ""}`),
      "",
      "Recognized apps and CLIs:",
      ...catalog.hosts.map((row) => `- ${row.label}${row.detected ? " (detected)" : ""}`),
    ].join("\n");
    const knownIds = new Set(catalog.harnesses.map(({ id }) => id));
    for (;;) {
      const raw = await ctx.ui.input(inventory, "IDs to ignore; prefix + to re-include; blank preserves current choices");
      if (raw == null) return undefined;
      const choices = raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
      const unknown = choices.filter((value) => !knownIds.has(value.startsWith("+") ? value.slice(1) : value));
      if (unknown.length) {
        ctx.ui.notify(`Unknown harness ID${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, "warning");
        continue;
      }
      const included = new Set(choices.filter((value) => value.startsWith("+")).map((value) => value.slice(1)));
      const ignored = new Set(choices.filter((value) => !value.startsWith("+")));
      const enabled = new Set(catalog.harnesses
        .filter(({ id, selected }) => (selected || included.has(id)) && !ignored.has(id))
        .map(({ format }) => format));
      const defaultsEnabled = new Set(catalog.harnesses.filter((row) => row.defaultsEnabled).map(({ format }) => format));
      for (const row of catalog.harnesses) {
        if (included.has(row.id)) defaultsEnabled.add(row.format);
      }
      return resultFrom(catalog, enabled, defaultsEnabled);
    }
  }

  let current = catalog;
  for (;;) {
    const interaction = await ctx.ui.custom<SessionCatalogReviewResult | { action: "manual" | "search"; selectedFormats: TranscriptFormat[]; defaultFormats: TranscriptFormat[] } | undefined>((tui, theme, _keybindings, done) => {
      const enabled = new Set(current.harnesses.filter(({ selected }) => selected).map(({ format }) => format));
      const defaultsEnabled = new Set(current.harnesses.filter((row) => row.defaultsEnabled).map(({ format }) => format));
      let cursor = 0;
      return {
        render(width: number): string[] {
          const line = (value: string) => truncateToWidth(value, width);
          const selected = current.harnesses[cursor];
          const hosts = current.hosts.map((row) => `${row.detected ? "●" : "○"} ${row.label}`).join(" · ");
          return [
            theme.fg("accent", "Agent session access"),
            ...wrapTextWithAnsi("New harnesses are included. Existing choices are preserved; mark any others to ignore.", width),
            ...wrapTextWithAnsi("A checked harness authorizes its listed standard and detected transcript stores.", width),
            "",
            ...current.harnesses.map((row, index) => line(
              `${index === cursor ? "›" : " "} ${enabled.has(row.format) ? "[x]" : "[ ]"} ${row.label}` +
              ` — ${row.detected ? `detected${row.detectedRoots[0] ? ` at ${row.detectedRoots[0]}` : ""}` : "not detected"}`,
            )),
            "",
            theme.fg("accent", `${selected?.label ?? "Harness"} transcript stores`),
            theme.fg("dim", selected && defaultsEnabled.has(selected.format) ? "Standard stores authorized" : "Standard stores ignored; explicit stores only"),
            ...wrapTextWithAnsi(selected?.roots.length ? selected.roots.join(" · ") : "No standard or detected store", width),
            "",
            theme.fg("accent", "Recognized apps and CLIs (session attribution only)"),
            theme.fg("dim", "● detected · ○ supported"),
            ...wrapTextWithAnsi(hosts, width),
            "",
            ...wrapTextWithAnsi(theme.fg("dim", `↑/↓ move · Space include/ignore · D toggle standard stores · A add store${options.searchMore ? " · S search more" : ""} · Enter continue · Esc cancel`), width),
          ];
        },
        invalidate(): void {},
        handleInput(data: string): void {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            done(undefined);
            return;
          } else if (matchesKey(data, "up")) cursor = (cursor - 1 + current.harnesses.length) % current.harnesses.length;
          else if (matchesKey(data, "down")) cursor = (cursor + 1) % current.harnesses.length;
          else if (matchesKey(data, "space")) {
            const format = current.harnesses[cursor]?.format;
            if (format) {
              if (enabled.has(format)) {
                enabled.delete(format);
                defaultsEnabled.delete(format);
              }
              else {
                enabled.add(format);
                defaultsEnabled.add(format);
              }
            }
          } else if (data.toLowerCase() === "a") {
            done({ action: "manual", selectedFormats: [...enabled], defaultFormats: [...defaultsEnabled] });
            return;
          } else if (options.searchMore && data.toLowerCase() === "s") {
            done({ action: "search", selectedFormats: [...enabled], defaultFormats: [...defaultsEnabled] });
            return;
          } else if (data.toLowerCase() === "d") {
            const format = current.harnesses[cursor]?.format;
            if (format) {
              if (defaultsEnabled.has(format)) defaultsEnabled.delete(format);
              else defaultsEnabled.add(format);
            }
          } else if (matchesKey(data, "return")) {
            done(resultFrom(current, enabled, defaultsEnabled));
            return;
          }
          tui.requestRender();
        },
      };
    });
    if (!interaction) return undefined;
    if (!("action" in interaction)) return interaction;
    const selected = new Set(interaction.selectedFormats);
    const defaultsEnabled = new Set(interaction.defaultFormats);
    current = {
      ...current,
      harnesses: current.harnesses.map((row) => ({
        ...row,
        selected: selected.has(row.format),
        defaultsEnabled: defaultsEnabled.has(row.format),
      })),
    };
    if (interaction.action === "search" && options.searchMore) {
      const found = await options.searchMore();
      const previous = new Map(current.harnesses.map((row) => [row.format, row]));
      current = {
        ...found,
        harnesses: found.harnesses.map((row) => ({
          ...row,
          roots: [...new Set([...(previous.get(row.format)?.roots ?? []), ...row.roots])],
          standardRoots: [...new Set([...(previous.get(row.format)?.standardRoots ?? []), ...row.standardRoots])],
          explicitRoots: [...new Set([...(previous.get(row.format)?.explicitRoots ?? []), ...row.explicitRoots])],
          detectedRoots: [...new Set([...(previous.get(row.format)?.detectedRoots ?? []), ...row.detectedRoots])],
          detected: row.detected || Boolean(previous.get(row.format)?.detected),
          selected: selected.has(row.format),
          defaultsEnabled: defaultsEnabled.has(row.format),
        })),
      };
      continue;
    }
    const harnessId = await ctx.ui.select("Add a transcript store", current.harnesses.map(({ id }) => id));
    if (!harnessId) continue;
    const raw = await ctx.ui.input(`Path to ${harnessId} transcripts`, "/absolute/path");
    const value = raw?.trim() ?? "";
    if (!value) continue;
    const root = value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
    if (!path.isAbsolute(root)) {
      ctx.ui.notify("Transcript store paths must be absolute.", "warning");
      continue;
    }
    const exists = options.pathExists?.(root) ?? existsSync(root);
    if (!exists) ctx.ui.notify("That transcript store does not exist yet. It will remain configured and activate when created.", "warning");
    current = {
      ...current,
      harnesses: current.harnesses.map((row) => row.id === harnessId
        ? {
            ...row,
            roots: [...new Set([...row.roots, root])],
            explicitRoots: [...new Set([...row.explicitRoots, root])],
            detectedRoots: exists ? [...new Set([...row.detectedRoots, root])] : row.detectedRoots,
            detected: row.detected || exists,
            selected: true,
          }
        : row),
    };
  }
}
