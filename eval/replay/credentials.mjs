// Credential material in a local capture: find it, and replace the value with a placeholder of
// exactly the same length.
//
// A capture is a second copy of transcripts the owner's own work wrote, so it holds whatever
// they hold — including real tokens. Replay needs those files byte-for-byte: message indexes,
// character budgets, and the scan's parsing all move if a file's length moves. Same-length
// replacement keeps every position identical and removes only the secret.
//
// Each pattern names the capture group holding the value. The surrounding text — the header it
// sat in, the URL parameter it belonged to, the tool call that produced it — is evidence and
// stays.

/** @type {ReadonlyArray<{ name: string, pattern: RegExp, group: number }>} */
export const CREDENTIAL_PATTERNS = [
  { name: "api-key", pattern: /\b((?:sk-ant-|sk-)[A-Za-z0-9_-]{20,})/g, group: 1 },
  { name: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,})/g, group: 1 },
  { name: "aws-access-key", pattern: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1 },
  { name: "google-api-key", pattern: /\b(AIza[0-9A-Za-z_-]{30,})/g, group: 1 },
  { name: "slack-token", pattern: /\b(xox[abprs]-[0-9A-Za-z-]{10,})/g, group: 1 },
  { name: "json-web-token", pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, group: 1 },
  { name: "oauth-parameter", pattern: /([?&](?:code|id_token|access_token|refresh_token|client_secret)=)([A-Za-z0-9._~-]{16,})/g, group: 2 },
  { name: "bearer-token", pattern: /([Aa]uthorization["'\s:]+Bearer\s+)([A-Za-z0-9._-]{20,})/g, group: 2 },
  { name: "private-key-body", pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----\s*)([A-Za-z0-9+/=\s]{40,}?)(\s*-----END)/g, group: 2 },
];

/**
 * A placeholder as long as the value it replaces, safe inside a JSON string. Its padding is `#`,
 * which no credential pattern accepts, so a placeholder never reads as a credential and running
 * this twice changes nothing.
 */
function placeholder(name, length) {
  const label = `[redacted-${name}]`;
  return length <= label.length ? "#".repeat(length) : label + "#".repeat(length - label.length);
}

/**
 * Replace every credential value in `text`. Returns the rewritten text, which is the same
 * length as the input, and the count per pattern.
 */
export function redactCredentials(text) {
  const counts = {};
  let redacted = text;
  for (const { name, pattern, group } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (...parts) => {
      const groups = parts.slice(0, -2);
      const value = groups[group];
      if (!value) return groups[0];
      counts[name] = (counts[name] ?? 0) + 1;
      const before = groups.slice(1, group).join("");
      const after = groups.slice(group + 1).join("");
      return `${before}${placeholder(name, value.length)}${after}`;
    });
  }
  return { text: redacted, counts };
}

/** How many credential values `text` still holds, by pattern. An empty object is clean. */
export function scanCredentials(text) {
  const counts = {};
  for (const { name, pattern, group } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[group]) counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

export function mergeCounts(into, from) {
  for (const [name, count] of Object.entries(from)) into[name] = (into[name] ?? 0) + count;
  return into;
}
