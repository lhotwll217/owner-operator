// Owner Operator privacy tool guard. The session scanner/store already enforce the
// blacklist; this supported Pi preflight hook closes the direct file-tool gap without
// replacing the built-ins that pi-tool-display owns for presentation.

import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isBlacklisted, loadBlacklist, pathIdentities, type Blacklist } from "@owner-operator/core";
import { repoRoot } from "../shared/repo-root";

type FileToolName = "read" | "grep" | "find" | "ls" | "edit" | "write";

const ooHome = (): string => process.env.OO_HOME ?? path.join(homedir(), ".owner-operator");
export interface PrivacyToolGuardOptions {
  callerSessionId?: string;
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

function deniedReason(rawPath: string, cwd: string, opts: { mayTraverse?: boolean } = {}): string | undefined {
  const verdict = blacklistedPathVerdict(rawPath, cwd);
  if (verdict.blacklisted) {
    return `Access denied: ${verdict.path} is blacklisted by ${path.join(ooHome(), "blacklist.json")}`;
  }
  if (opts.mayTraverse) {
    const descendant = blacklistedDescendantVerdict(rawPath, cwd);
    if (descendant.blacklisted) {
      return `Access denied: ${descendant.root} would traverse blacklisted path ${descendant.path}`;
    }
  }
}

const fileToolPolicy: Record<FileToolName, { defaultPath?: string; mayTraverse: boolean }> = {
  read: { mayTraverse: false },
  grep: { defaultPath: ".", mayTraverse: true },
  find: { defaultPath: ".", mayTraverse: true },
  ls: { defaultPath: ".", mayTraverse: true },
  edit: { mayTraverse: false },
  write: { mayTraverse: false },
};

function isFileToolName(value: string): value is FileToolName {
  return Object.hasOwn(fileToolPolicy, value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function addOwnerOperatorBashEnvironment(command: string, opts: PrivacyToolGuardOptions = {}): string {
  const assignments = [
    `OO_INSTALL_ROOT=${shellQuote(repoRoot)}`,
    `OO_HOME=${shellQuote(ooHome())}`,
  ];
  if (opts.callerSessionId) assignments.push(`OO_CALLER_SESSION_ID=${shellQuote(opts.callerSessionId)}`);
  return `export ${assignments.join(" ")}\n${command}`;
}

/** Apply Owner Operator's supported tool_call preflight policy. */
export function guardOwnerOperatorToolCall(
  event: ToolCallEvent,
  cwd: string,
  opts: PrivacyToolGuardOptions = {},
): { block: true; reason: string } | undefined {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "bash") {
    if (typeof input.command === "string") {
      input.command = addOwnerOperatorBashEnvironment(input.command, opts);
    }
    return;
  }
  if (!isFileToolName(event.toolName)) return;
  const policy = fileToolPolicy[event.toolName];
  const rawPath = typeof input.path === "string" ? input.path : policy.defaultPath;
  if (rawPath === undefined) {
    return { block: true, reason: `Access denied: ${event.toolName} requires a path` };
  }
  const reason = deniedReason(rawPath, cwd, { mayTraverse: policy.mayTraverse });
  return reason ? { block: true, reason } : undefined;
}

export const createPrivacyToolGuardExtension = (
  opts: PrivacyToolGuardOptions = {},
): ExtensionFactory => (pi) => {
  pi.on("tool_call", (event, ctx) => guardOwnerOperatorToolCall(event, ctx.cwd, opts));
};

export const privacyToolGuardExtension = createPrivacyToolGuardExtension();
