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
  verbs: {
    install: {
      summary: "link this checkout's skill into the shared skills root and every harness folder that exists",
      async run({ json }) {
        const changes = installSkillLinks();
        emit(json, changes, () => changes.map(changeLine).join("\n"));
        return 0;
      },
    },
    uninstall: {
      summary: "remove only the links `oo skill install` created",
      async run({ json }) {
        const changes = uninstallSkillLinks();
        emit(json, changes, () => changes.map(changeLine).join("\n"));
        return 0;
      },
    },
    status: {
      summary: "each link's target and whether it resolves",
      async run({ json }) {
        const statuses = skillLinkStatus();
        emit(json, statuses, () => statuses.map(statusLine).join("\n"));
        return statuses.some((status) => status.state === "dangling") ? 1 : 0;
      },
    },
  },
};
