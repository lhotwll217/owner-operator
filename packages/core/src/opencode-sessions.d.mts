// Hand-written declarations for opencode-sessions.mjs (plain ESM so the scan and search wrappers
// import it without a build step). Keep in lockstep with opencode-sessions.mjs.

export interface OpenCodeDatabase {
  readonly v1: boolean;
  readonly v2: boolean;
  readonly parts: boolean;
  close(): void;
}

export interface OpenCodeSession {
  id: string;
  directory: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OpenCodeMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
  completed: boolean;
}

export declare function openCodeDatabasePath(storeRoot: string): string;
export declare function openOpenCodeDatabase(path: string): OpenCodeDatabase | null;
export declare function listOpenCodeSessions(handle: OpenCodeDatabase, since?: number): OpenCodeSession[];
export declare function readOpenCodeMessages(handle: OpenCodeDatabase, sessionId: string): OpenCodeMessage[];
