import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { GatewayApi, UseWorktreeResult } from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

type UseWorktreeBackend = Pick<GatewayApi, "useWorktree">;

export interface UseWorktreeToolOptions {
  resolveGateway?: () => Promise<UseWorktreeBackend>;
}

function result(details: UseWorktreeResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export function createUseWorktreeTool(options: UseWorktreeToolOptions = {}) {
  const getGateway = options.resolveGateway ?? resolveBackend;
  return defineTool({
    name: "use_worktree",
    label: "Use worktree",
    description:
      "Create, list, or select Git worktrees created by Owner Operator. Create when task changes " +
      "should be isolated from the current checkout. List reports durable OO creation records and " +
      "fresh Git availability. Select records one current worktree for this root. The root identity " +
      "comes from the active session automatically. This capability does not remove or clean up worktrees.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("create"),
        repository: Type.String({
          minLength: 1,
          description: "Absolute path inside the existing Git repository that will own the linked worktree.",
        }),
        name: Type.String({
          minLength: 1,
          description: "New branch name and relative path below $OO_HOME/worktrees/<repository>/.",
        }),
        base: Type.Optional(Type.String({
          minLength: 1,
          description: "Optional Git revision for the new branch. Defaults to HEAD in repository.",
        })),
      }),
      Type.Object({
        action: Type.Literal("list"),
        repository: Type.Optional(Type.String({
          minLength: 1,
          description: "Optional registered repository-name filter, such as owner-operator.",
        })),
      }),
      Type.Object({
        action: Type.Literal("select"),
        worktreeId: Type.String({ minLength: 1, description: "Exact stable id returned by create or list." }),
      }),
    ]),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const details = await (await getGateway()).useWorktree({
        threadId: ctx.sessionManager.getSessionId(),
        input: params,
      });
      return result(details);
    },
  });
}

export const useWorktreeTool = createUseWorktreeTool();
