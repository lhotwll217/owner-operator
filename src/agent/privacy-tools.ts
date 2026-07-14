// Owner Operator privacy tool layer. The session scanner/store already enforce the
// blacklist; these wrappers close the raw pi file-tool gap at the tool boundary.

import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isBlacklisted, loadBlacklist, pathIdentities, type Blacklist } from "@owner-operator/core";
import { ooRenderCall } from "../shared/oo-presentation";
import { repoRoot } from "../shared/repo-root";

type AnyTool = ToolDefinition<any, any, any>;
type FileToolName = "read" | "grep" | "find" | "ls" | "edit" | "write";

const ooHome = (): string => process.env.OO_HOME ?? path.join(homedir(), ".owner-operator");
export interface OwnerOperatorBashToolOptions {
  callerSessionId?: string;
}
const cache = new Map<string, Record<FileToolName, AnyTool>>();

function builtIns(cwd: string): Record<FileToolName, AnyTool> {
  let tools = cache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
    };
    cache.set(cwd, tools);
  }
  return tools;
}

function normalizeInputPath(raw: string, cwd: string): string {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(cwd, p || ".");
}

function existingAncestor(abs: string): string {
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    cur = parent;
  }
  return cur;
}

function directoryIdentity(abs: string): string {
  const existing = existingAncestor(abs);
  try {
    return statSync(existing).isDirectory() ? existing : path.dirname(existing);
  } catch {
    return path.dirname(abs);
  }
}

function gitRoot(start: string): string | null {
  let cur = directoryIdentity(start);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function repoName(abs: string): string | null {
  const root = gitRoot(abs);
  if (!root) return path.basename(directoryIdentity(abs)) || null;
  const dotGit = path.join(root, ".git");
  try {
    if (statSync(dotGit).isFile()) {
      const raw = readFileSync(dotGit, "utf8");
      const gitDir = /^gitdir:\s*(.+)\s*$/m.exec(raw)?.[1]?.trim();
      if (gitDir) {
        const resolved = path.isAbsolute(gitDir) ? gitDir : path.resolve(root, gitDir);
        const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
        const i = resolved.indexOf(marker);
        if (i > 0) return path.basename(resolved.slice(0, i));
      }
    }
  } catch {
    // Broken/missing .git metadata falls back to the visible checkout directory.
  }
  return path.basename(root) || null;
}

const stripTrailingSep = (p: string): string => {
  const root = path.parse(p).root;
  return p === root ? p : p.replace(/[\\/]+$/, "");
};

const foldPath = (p: string): string => stripTrailingSep(p).toLowerCase();

function sameOrDescendant(parent: string, child: string): boolean {
  const p = foldPath(parent);
  const c = foldPath(child);
  if (p === c) return true;
  const root = path.parse(parent).root;
  return parent === root ? c.startsWith(foldPath(root)) : c.startsWith(p + path.sep.toLowerCase());
}

function blacklistWithRealPaths(bl: Blacklist): Blacklist {
  return {
    paths: [...new Set(bl.paths.flatMap(pathIdentities))],
    repos: bl.repos,
  };
}

function toolBlacklist(): Blacklist {
  return blacklistWithRealPaths(loadBlacklist(ooHome()));
}

export function blacklistedPathVerdict(rawPath: string, cwd: string, bl: Blacklist = toolBlacklist()):
  | { blacklisted: false; path: string }
  | { blacklisted: true; path: string } {
  const lexical = normalizeInputPath(rawPath, cwd);
  const candidates = pathIdentities(lexical);
  for (const candidate of candidates) {
    if (isBlacklisted(bl, { cwd: candidate, repo: repoName(candidate) })) {
      return { blacklisted: true, path: candidate };
    }
  }
  return { blacklisted: false, path: lexical };
}

export function blacklistedDescendantVerdict(rawPath: string, cwd: string, bl: Blacklist = toolBlacklist()):
  | { blacklisted: false }
  | { blacklisted: true; path: string; root: string } {
  const lexical = normalizeInputPath(rawPath, cwd);
  const roots = pathIdentities(lexical);
  const blocked = [...new Set(bl.paths.flatMap(pathIdentities))];
  for (const root of roots) {
    for (const blockedPath of blocked) {
      if (sameOrDescendant(root, blockedPath)) return { blacklisted: true, path: blockedPath, root };
    }
  }
  return { blacklisted: false };
}

function assertAllowed(rawPath: string, cwd: string, opts: { mayTraverse?: boolean } = {}): void {
  const verdict = blacklistedPathVerdict(rawPath, cwd);
  if (verdict.blacklisted) {
    throw new Error(`Access denied: ${verdict.path} is blacklisted by ${path.join(ooHome(), "blacklist.json")}`);
  }
  if (opts.mayTraverse) {
    const descendant = blacklistedDescendantVerdict(rawPath, cwd);
    if (descendant.blacklisted) {
      throw new Error(`Access denied: ${descendant.root} would traverse blacklisted path ${descendant.path}`);
    }
  }
}

function wrapFileTool(name: FileToolName, defaultPath: (params: any) => string, opts: { mayTraverse?: boolean } = {}): AnyTool {
  const seed = builtIns(process.cwd())[name];
  return {
    ...seed,
    // Compact the CALL row to a single OO line; keep pi's built-in result renderer, so a
    // `read` still previews (syntax-highlighted, expandable) — owner-directed file content,
    // not agent chatter, so we declutter the header without regressing the output.
    renderCall: ooRenderCall(name, (p) => defaultPath(p)),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      assertAllowed(defaultPath(params), cwd, opts);
      return builtIns(cwd)[name].execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function createBlacklistAwareFileTools(): AnyTool[] {
  return [
    wrapFileTool("read", (p) => p.path),
    wrapFileTool("grep", (p) => p.path ?? ".", { mayTraverse: true }),
    wrapFileTool("find", (p) => p.path ?? ".", { mayTraverse: true }),
    wrapFileTool("ls", (p) => p.path ?? ".", { mayTraverse: true }),
    wrapFileTool("edit", (p) => p.path),
    wrapFileTool("write", (p) => p.path),
  ];
}

export function createOwnerOperatorBashTool(
  opts: OwnerOperatorBashToolOptions = {},
): ReturnType<typeof createBashToolDefinition> {
  const spawnHook = (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
    ...context,
    env: {
      ...context.env,
      OO_INSTALL_ROOT: repoRoot,
      ...(opts.callerSessionId ? { OO_CALLER_SESSION_ID: opts.callerSessionId } : {}),
    },
  });
  const seed = createBashToolDefinition(process.cwd(), { spawnHook });
  const tool: ReturnType<typeof createBashToolDefinition> = {
    ...seed,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      return createBashToolDefinition(cwd, { spawnHook }).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  return tool;
}

export function registerBlacklistAwareFileTools(
  pi: ExtensionAPI,
  opts: OwnerOperatorBashToolOptions = {},
): void {
  for (const tool of createBlacklistAwareFileTools()) pi.registerTool(tool);
  pi.registerTool(createOwnerOperatorBashTool(opts));
}

export const blacklistAwareFileToolsExtension: ExtensionFactory = (pi) => {
  registerBlacklistAwareFileTools(pi);
};

export const createBlacklistAwareFileToolsExtension = (
  opts: OwnerOperatorBashToolOptions = {},
): ExtensionFactory => (pi) => {
  registerBlacklistAwareFileTools(pi, opts);
};
