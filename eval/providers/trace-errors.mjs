import fs from "node:fs";

export function readFatalModelError(traceFile, sessionTraceFile = null) {
  const traceError = readNdjson(traceFile).find((event) =>
    event?.event === "turn" && event.stopReason === "error"
  );
  if (!traceError) return null;

  const sessionError = readNdjson(sessionTraceFile).findLast((event) =>
    event?.type === "message" &&
    event.message?.role === "assistant" &&
    event.message?.stopReason === "error"
  );
  return firstText(traceError.errorMessage, sessionError?.message?.errorMessage) ??
    "model turn stopped with an error";
}

function readNdjson(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}
