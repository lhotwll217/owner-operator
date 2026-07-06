// Owner Operator privacy tool layer. The session scanner/store already enforce the
// blacklist; these wrappers close the raw pi file-tool gap at the tool boundary.

import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isBlacklisted, loadBlacklist, type Blacklist } from "@owner-operator/core";

type AnyTool = ToolDefinition<any, any, any>;
type FileToolName = "read" | "grep" | "find" | "ls";

const ooHome = (): string => process.env.OO_HOME ?? path.join(homedir(), ".owner-operator");
const cache = new Map<string, Record<FileToolName, AnyTool>>();

function builtIns(cwd: string): Record<FileToolName, AnyTool> {
  let tools = cache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
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

function realPathIfPresent(abs: string): string | null {
  try {
    return realpathSync.native(abs);
  } catch {
    return null;
  }
}

function blacklistWithRealPaths(bl: Blacklist): Blacklist {
  return {
    paths: [...new Set(bl.paths.flatMap((p) => [p, realPathIfPresent(p)].filter((v): v is string => !!v)))],
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
  const candidates = [lexical, realPathIfPresent(lexical)].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (isBlacklisted(bl, { cwd: candidate, repo: repoName(candidate) })) {
      return { blacklisted: true, path: candidate };
    }
  }
  return { blacklisted: false, path: lexical };
}

function assertAllowed(rawPath: string, cwd: string): void {
  const verdict = blacklistedPathVerdict(rawPath, cwd);
  if (verdict.blacklisted) {
    throw new Error(`Access denied: ${verdict.path} is blacklisted by ${path.join(ooHome(), "blacklist.json")}`);
  }
}

function wrapFileTool(name: FileToolName, defaultPath: (params: any) => string): AnyTool {
  const seed = builtIns(process.cwd())[name];
  return {
    ...seed,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      assertAllowed(defaultPath(params), cwd);
      return builtIns(cwd)[name].execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function createBlacklistAwareFileTools(): AnyTool[] {
  return [
    wrapFileTool("read", (p) => p.path),
    wrapFileTool("grep", (p) => p.path ?? "."),
    wrapFileTool("find", (p) => p.path ?? "."),
    wrapFileTool("ls", (p) => p.path ?? "."),
  ];
}

export function registerBlacklistAwareFileTools(pi: ExtensionAPI): void {
  for (const tool of createBlacklistAwareFileTools()) pi.registerTool(tool);
}
