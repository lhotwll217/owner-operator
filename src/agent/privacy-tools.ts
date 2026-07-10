// Owner Operator privacy tool layer. The session scanner/store already enforce the
// blacklist; these wrappers close the raw pi file-tool gap at the tool boundary.

import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isBlacklisted, loadBlacklist, type Blacklist } from "@owner-operator/core";
import { ooRenderCall } from "../shared/oo-presentation";

type AnyTool = ToolDefinition<any, any, any>;
type FileToolName = "read" | "grep" | "find" | "ls" | "edit" | "write";

const ooHome = (): string => process.env.OO_HOME ?? path.join(homedir(), ".owner-operator");
const execFileAsync = promisify(execFile);
const sessionSearchScript = (): string => path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "skills", "session-search", "scripts", "session-search.mjs",
);

export enum OwnerOperatorBashCommand {
  SessionSearch = "session-search",
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

function resolvedPathCandidate(abs: string): string | null {
  try {
    return realpathSync.native(abs);
  } catch {
    const ancestor = existingAncestor(abs);
    try {
      return path.resolve(realpathSync.native(ancestor), path.relative(ancestor, abs));
    } catch {
      return null;
    }
  }
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
    paths: [...new Set(bl.paths.flatMap((p) => [p, resolvedPathCandidate(p)].filter((v): v is string => !!v)))],
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
  const candidates = [lexical, resolvedPathCandidate(lexical)].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    if (isBlacklisted(bl, { cwd: candidate, repo: repoName(candidate) })) {
      return { blacklisted: true, path: candidate };
    }
  }
  return { blacklisted: false, path: lexical };
}

function blacklistedDescendantVerdict(rawPath: string, cwd: string, bl: Blacklist = toolBlacklist()):
  | { blacklisted: false }
  | { blacklisted: true; path: string; root: string } {
  const lexical = normalizeInputPath(rawPath, cwd);
  const roots = [lexical, resolvedPathCandidate(lexical)].filter((p): p is string => !!p);
  const blocked = [...new Set(bl.paths.flatMap((p) => [p, resolvedPathCandidate(p)].filter((v): v is string => !!v)))];
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

/** Same-name Pi override: skills keep the standard bash tool name, but product policy
 * narrows it to one exact argv-based helper. No shell ever interprets model input. */
export function createOwnerOperatorBashTool(): AnyTool {
  return defineTool({
    name: "bash",
    label: "Run session search",
    description: "Run the bundled session-search skill helper with an explicit argument array. No other command is available.",
    parameters: Type.Object({
      command: Type.Literal(OwnerOperatorBashCommand.SessionSearch),
      args: Type.Array(Type.String(), { description: "Arguments passed verbatim to session-search.mjs." }),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 120, description: "Timeout in seconds. Default 30." })),
    }),
    async execute(_id, params, signal) {
      if (params.command !== OwnerOperatorBashCommand.SessionSearch) {
        throw new Error("Owner Operator bash only runs the session-search skill helper");
      }
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [sessionSearchScript(), ...params.args],
        {
          cwd: path.dirname(sessionSearchScript()),
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          signal,
          timeout: (params.timeout ?? 30) * 1_000,
        },
      );
      return {
        content: [{ type: "text" as const, text: `${stdout}${stderr}`.trim() || "(no output)" }],
        details: undefined,
      };
    },
  });
}

export function registerBlacklistAwareFileTools(pi: ExtensionAPI): void {
  for (const tool of createBlacklistAwareFileTools()) pi.registerTool(tool);
  pi.registerTool(createOwnerOperatorBashTool());
}

export const blacklistAwareFileToolsExtension: ExtensionFactory = (pi) => {
  registerBlacklistAwareFileTools(pi);
};
