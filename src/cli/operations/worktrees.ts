import { resolve } from "node:path";
import type { UseWorktreeInput, WorktreeInfo } from "@owner-operator/core";
import { parentSessionId } from "../../shared/caller-session";
import { emit, gateway, UsageError, type Noun, type VerbValues } from "./operation";

const FROM_SESSION = {
  "from-session": {
    type: "string" as const,
    help: "the session whose worktree this is (default: the Operator session running this bash, else the calling session)",
  },
};

const worktreeLine = (worktree: WorktreeInfo): string =>
  `${worktree.id}  ${worktree.selected ? "selected " : "         "}${worktree.available ? "available  " : "unavailable"} ${worktree.repository}  ${worktree.path}`;

/** Selection is per session (POST /worktrees/use's threadId); the interactive Operator rebinds its
 * runtime cwd to the selection when its agent run settles (src/agent/worktree-runtime.ts). */
async function useWorktree(values: VerbValues, input: UseWorktreeInput) {
  const threadId = parentSessionId(typeof values["from-session"] === "string" ? values["from-session"] : undefined);
  if (!threadId) {
    throw new UsageError("no session to act for: pass --from-session <id>, or run from an Operator session or a coding agent that identifies itself");
  }
  return (await gateway()).useWorktree({ threadId, input });
}

export const worktrees: Noun = {
  summary: "Git worktrees created by Owner Operator, selected per session (/worktrees/use)",
  useWhen: "isolating task changes in a new linked worktree, listing Owner Operator's worktrees, or switching which one a session works in",
  verbs: {
    create: {
      summary: "create a linked worktree and branch under $OO_HOME/worktrees/<repository>/<name>, and select it",
      options: {
        repository: { type: "string", help: "path inside the Git repository that will own the worktree (required)" },
        name: { type: "string", help: "new branch name and relative path below the repository's worktree folder (required)" },
        base: { type: "string", help: "Git revision for the new branch (default: HEAD in --repository)" },
        ...FROM_SESSION,
      },
      examples: [
        "oo worktrees create --repository . --name fix-lint",
        "oo worktrees create --repository ~/code/app --name review-42 --base origin/main --json",
      ],
      async run({ values, json }) {
        if (typeof values.repository !== "string") throw new UsageError("--repository <path> is required");
        if (typeof values.name !== "string") throw new UsageError("--name <name> is required");
        const result = await useWorktree(values, {
          action: "create",
          repository: resolve(values.repository),
          name: values.name,
          ...(typeof values.base === "string" ? { base: values.base } : {}),
        });
        await emit(json, result, () => result.action === "create"
          ? `${result.created ? "created" : "exists"}  ${worktreeLine(result.worktree)}`
          : "");
        return 0;
      },
    },
    list: {
      summary: "every Owner Operator worktree, with live Git availability and this session's selection",
      options: {
        repository: { type: "string", help: "only worktrees of this registered repository name, e.g. owner-operator" },
        ...FROM_SESSION,
      },
      examples: ["oo worktrees list", "oo worktrees list --repository owner-operator --json"],
      async run({ values, json }) {
        const result = await useWorktree(values, {
          action: "list",
          ...(typeof values.repository === "string" ? { repository: values.repository } : {}),
        });
        await emit(json, result, () => result.action === "list" && result.worktrees.length
          ? result.worktrees.map(worktreeLine).join("\n")
          : "no worktrees");
        return 0;
      },
    },
    select: {
      args: "<worktree-id>",
      summary: "make a worktree this session's working directory; the interactive Operator switches to it after the current turn",
      minPositionals: 1,
      options: { ...FROM_SESSION },
      examples: ["oo worktrees select <worktree-id>", "oo worktrees select <worktree-id> --from-session <session-id> --json"],
      async run({ values, positionals: [worktreeId], json }) {
        const result = await useWorktree(values, { action: "select", worktreeId: worktreeId! });
        await emit(json, result, () => result.action === "select" ? worktreeLine(result.worktree) : "");
        return 0;
      },
    },
  },
};
