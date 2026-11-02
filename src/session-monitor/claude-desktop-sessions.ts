import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_ID = /^local_[0-9a-f-]{36}$/;

interface DesktopRecord { mtimeMs: number; cliSessionId: string | null; sessionId: string | null }

/**
 * Claude desktop's local session records, indexed by the CLI transcript id each one carries.
 * The record format is undocumented, so every doubt yields no link: a missing root, an
 * unreadable or malformed record, a missing CLI id, an unexpected session id, or one CLI id
 * claimed by two records.
 */
export class ClaudeDesktopSessions {
  private readonly records = new Map<string, DesktopRecord>();

  constructor(
    private readonly root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
  ) {}

  /** `claude://claude.ai/epitaxy/<sessionId>` for each thread id the desktop app unambiguously owns. */
  async links(threadIds: readonly string[]): Promise<Map<string, string>> {
    await this.refresh();
    const owners = new Map<string, string | null>();
    for (const record of this.records.values()) {
      if (!record.cliSessionId) continue;
      owners.set(record.cliSessionId, owners.has(record.cliSessionId) ? null : record.sessionId);
    }
    const links = new Map<string, string>();
    for (const id of threadIds) {
      const sessionId = owners.get(id);
      if (sessionId) links.set(id, `claude://claude.ai/epitaxy/${sessionId}`);
    }
    return links;
  }

  /** Re-reads only records whose mtime changed and forgets records that vanished. */
  private async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const path of await this.recordPaths()) {
      seen.add(path);
      const mtimeMs = await stat(path).then((info) => info.mtimeMs, () => null);
      if (mtimeMs === null) { seen.delete(path); continue; }
      if (this.records.get(path)?.mtimeMs === mtimeMs) continue;
      this.records.set(path, { mtimeMs, ...await parseRecord(path) });
    }
    for (const path of this.records.keys()) if (!seen.has(path)) this.records.delete(path);
  }

  /** `local_*.json` exactly two directory levels below the root; no recursion. */
  private async recordPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const first of await subdirectories(this.root)) {
      for (const second of await subdirectories(first)) {
        const files = await readdir(second).catch(() => [] as string[]);
        for (const file of files) if (file.startsWith("local_") && file.endsWith(".json")) paths.push(join(second, file));
      }
    }
    return paths;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name));
}

async function parseRecord(path: string): Promise<Omit<DesktopRecord, "mtimeMs">> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as { cliSessionId?: unknown; sessionId?: unknown };
    const cliSessionId = typeof record.cliSessionId === "string" && record.cliSessionId ? record.cliSessionId : null;
    const sessionId = typeof record.sessionId === "string" && SESSION_ID.test(record.sessionId) ? record.sessionId : null;
    return { cliSessionId, sessionId };
  } catch {
    return { cliSessionId: null, sessionId: null };
  }
}
