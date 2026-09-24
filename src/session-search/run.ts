import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SessionSearchRequest, SessionSearchResult } from "@owner-operator/core";

const wrapper = fileURLToPath(new URL("./session-search.mjs", import.meta.url));

/** Run the privacy-aware search wrapper as a daemon child. The request supplies only the
 * wrapper's argv and its caller-identity inputs; OO_HOME, and therefore the blacklist and
 * configured sources, stay the daemon's own. The wrapper's flags and output are the contract. */
export function runSessionSearch(request: SessionSearchRequest): Promise<SessionSearchResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OO_CALLER_SESSION_ID;
  delete env.OO_CURRENT_SESSION_ID;
  if (request.callerSessionId) env.OO_CALLER_SESSION_ID = request.callerSessionId;
  if (request.currentSessionId) env.OO_CURRENT_SESSION_ID = request.currentSessionId;
  return new Promise((resolve) => {
    execFile(process.execPath, [wrapper, ...request.args], {
      cwd: request.cwd,
      env,
      encoding: "utf8",
      // The wrapper's own primitive buffer (session-search.mjs runPrimitive).
      maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = (error as (Error & { code?: unknown }) | null)?.code;
      resolve({
        exitCode: error ? (typeof code === "number" ? code : 1) : 0,
        stdout,
        stderr: stderr || (error && typeof code !== "number" ? `${error.message}\n` : ""),
      });
    });
  });
}
