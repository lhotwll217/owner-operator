// Unit: CLI conventions that keep `oo` a complete, self-describing surface for agents. Every verb
// documents itself with examples, and every agent-facing Gateway route is reachable through a verb
// (adr/0001-agent-uses-its-own-cli.md). Reads source text only; no daemon, no temp files.
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../shared/repo-root";
import { NOUNS } from "./operations";
import { verbHelp } from "./operations/operation";

for (const [nounName, noun] of Object.entries(NOUNS)) {
  assert.ok(noun.useWhen.trim(), `oo ${nounName} says which questions it answers`);
  for (const [verbName, verb] of Object.entries(noun.verbs)) {
    const prefix = `oo ${nounName} ${verbName}`;
    assert.ok(verb.examples.length >= 1, `${prefix} has at least one example`);
    for (const example of verb.examples) {
      assert.ok(example === prefix || example.startsWith(`${prefix} `), `${prefix} example "${example}" starts with "${prefix}"`);
    }
    const help = verbHelp(nounName, verbName, verb);
    assert.match(help, /--json/, `${prefix} --help documents --json`);
    assert.match(help, /^Examples:$/m, `${prefix} --help shows its examples`);
  }
}

const source = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

/** A path literal's text with each `${…}` resolved: right after a `/` it is a path parameter,
 * anywhere else it only builds a query string and is dropped. Query strings are stripped. */
function routePath(literal: string): string {
  let path = "";
  for (let index = 0; index < literal.length; index++) {
    if (literal.startsWith("${", index)) {
      let depth = 0;
      for (; index < literal.length; index++) {
        if (literal[index] === "{") depth++;
        else if (literal[index] === "}" && --depth === 0) break;
      }
      if (path.endsWith("/")) path += ":id";
    } else {
      path += literal[index];
    }
  }
  return path.split("?")[0]!;
}

/** The body of the first string or template literal in `text` that begins with `/`. */
function firstPathLiteral(text: string): string | undefined {
  const start = /["`]\//.exec(text);
  if (!start) return undefined;
  const quote = text[start.index]!;
  let depth = 0;
  for (let index = start.index + 1; index < text.length; index++) {
    if (quote === "`" && text.startsWith("${", index)) depth++;
    else if (depth && text[index] === "}") depth--;
    else if (!depth && text[index] === quote) return text.slice(start.index + 1, index);
  }
  return undefined;
}

// Routes are dispatched in src/gateway/server.ts either by `route === "METHOD /path"` or, for
// id-scoped routes, by `request.method === "METHOD" && url.pathname === \`/path/${id}\``.
const serverSource = source("src/gateway/server.ts");
const routes = new Set<string>();
for (const match of serverSource.matchAll(/route === "([A-Z]+) (\/[^"]*)"/g)) routes.add(`${match[1]} ${match[2]}`);
for (const match of serverSource.matchAll(/request\.method === "([A-Z]+)" && url\.pathname === `([^`]+)`/g)) {
  routes.add(`${match[1]} ${routePath(match[2]!)}`);
}
for (const known of ["GET /session-state", "POST /query-database", "PUT /schedules/:id", "GET /agent-runs/:id/events"]) {
  assert.ok(routes.has(known), `the route parser finds ${known} (found: ${[...routes].join(", ")})`);
}

// GatewayClient methods are the properties of the object connectGateway returns; each one's
// first path literal and its request shape give the route it calls.
const clientSource = source("src/gateway/client.ts");
const clientBody = clientSource.slice(clientSource.indexOf("export async function connectGateway"));
const objectBody = clientBody.slice(clientBody.indexOf("  return {\n"), clientBody.indexOf("\n  };\n"));
const methodStarts = [...objectBody.matchAll(/^ {4}(?:async \*)?(\w+)(?::|\()/gm)];
const clientRoutes = new Map<string, string>();
methodStarts.forEach((match, index) => {
  const body = objectBody.slice(match.index, methodStarts[index + 1]?.index ?? objectBody.length);
  const literal = firstPathLiteral(body);
  if (!literal) return;
  const method = /method: "(PUT|DELETE)"/.exec(body)?.[1] ?? (/\bpost[<(]/.test(body) ? "POST" : "GET");
  clientRoutes.set(match[1]!, `${method} ${routePath(literal)}`);
});
for (const [method, route] of [["sessionState", "GET /session-state"], ["deleteSchedule", "DELETE /schedules/:id"], ["agentRunLog", "GET /agent-runs/:id/events"]]) {
  assert.equal(clientRoutes.get(method!), route, `the client parser maps ${method} to ${route}`);
}
for (const route of clientRoutes.values()) assert.ok(routes.has(route), `client route ${route} exists on the server`);

// A verb reaches a route when its noun file calls the client method for it.
const operationsDir = join(repoRoot, "src", "cli", "operations");
const cliSource = readdirSync(operationsDir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => readFileSync(join(operationsDir, file), "utf8"))
  .join("\n");
const reached = new Set<string>();
for (const [method, route] of clientRoutes) {
  if (new RegExp(`\\.${method}\\(`).test(cliSource)) reached.add(route);
}

/** Routes only Owner Operator's own apps and internals call; an agent has no use for them. */
const APP_ONLY: Record<string, string> = {
  "GET /health": "daemon discovery and liveness probe (gateway/client.ts probeGateway, daemon/ensure.ts)",
  "GET /ready": "readiness probe (gateway/client.ts probeGateway, widget DaemonClient.swift)",
  "GET /events": "SSE invalidation stream for the widget (DaemonClient.swift) and GatewayApi.subscribe",
  "POST /rename": "widget row rename (DaemonClient.swift)",
  "POST /poll": "monitor rescan trigger; GatewayApi.poll has no product caller beyond Gateway tests",
  "GET /agent-state": "parent-run projection; the TUI and completion delivery derive it in-process (agent-runs/agent-state-projection.ts), only daemon e2e tests call the route",
};

/** Agent-facing routes with no verb yet; each names the native tool that still covers it. */
const PENDING: Record<string, string> = {
  "POST /worktrees/use": "use_worktree selects the Operator session's worktree",
  "GET /worktrees/resolve-cwd": "delegate_agent resolves its default cwd to the session worktree; `oo runs delegate` defaults to the shell cwd",
  "POST /agent-runs/:id/wait": "delegate_agent waitSeconds; `oo runs logs --follow` waits by streaming instead",
};

for (const [table, entries] of [["APP_ONLY", APP_ONLY], ["PENDING", PENDING]] as const) {
  for (const [route, reason] of Object.entries(entries)) {
    assert.ok(routes.has(route), `${table} exempts ${route}, which no longer exists; remove the exemption`);
    assert.ok(!reached.has(route), `${table} exempts ${route}, which an oo verb now reaches; remove the exemption`);
    assert.ok(reason.trim(), `${table} gives a reason for ${route}`);
  }
}
const uncovered = [...routes].filter((route) => !reached.has(route) && !(route in APP_ONLY) && !(route in PENDING));
assert.deepEqual(uncovered, [], "every agent-facing route has an oo verb; add one or exempt the route with a reason");

process.stdout.write(`ok — cli conventions: verbs carry examples; ${reached.size}/${routes.size} Gateway routes reached by a verb, the rest exempt with reasons\n`);
