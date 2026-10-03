import {
  installSkillLinks,
  skillLinkStatus,
  uninstallSkillLinks,
  type SkillLinkChange,
  type SkillLinkStatus,
} from "../../shared/skill-links";
import { emit, type Noun } from "./operation";

const changeLine = (change: SkillLinkChange): string =>
  `${change.action.padEnd(14)} ${change.label.padEnd(7)} ${change.path}${change.detail ? `  (${change.detail})` : ""}`;

export const statusLine = (status: SkillLinkStatus): string =>
  `${status.state.padEnd(10)} ${status.label.padEnd(7)} ${status.path}${status.linkTarget ? ` -> ${status.linkTarget}` : ""}` +
  `${status.state === "dangling" ? "  (target missing: the checkout moved; run `oo skill install` from it)" : ""}`;

export const skill: Noun = {
  summary: "the outside-agent skill, linked into Claude Code, Codex, and Cursor",
  useWhen: "installing, removing, or checking the skill that lets outside coding agents call `oo`",
  verbs: {
    install: {
      summary: "link this checkout's skill into the shared skills root and every harness folder that exists",
      examples: ["oo skill install", "oo skill install --json"],
      async run({ json }) {
        const changes = installSkillLinks();
        await emit(json, changes, () => changes.map(changeLine).join("\n"));
        return 0;
      },
    },
    uninstall: {
      summary: "remove only the links `oo skill install` created",
      examples: ["oo skill uninstall"],
      async run({ json }) {
        const changes = uninstallSkillLinks();
        await emit(json, changes, () => changes.map(changeLine).join("\n"));
        return 0;
      },
    },
    status: {
      summary: "each link's target and whether it resolves",
      examples: ["oo skill status", "oo skill status --json"],
      async run({ json }) {
        const statuses = skillLinkStatus();
        await emit(json, statuses, () => statuses.map(statusLine).join("\n"));
        return statuses.some((status) => status.state === "dangling") ? 1 : 0;
      },
    },
  },
};
