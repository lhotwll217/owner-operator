import assert from "node:assert";
import { KNOWN_TRANSCRIPT_FORMATS, REVIEWED_SESSION_HOSTS } from "@owner-operator/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSessionCatalogReview, reviewSessionCatalog } from "./session-catalog-review";

const catalog = buildSessionCatalogReview(
  [{ source: "codex", root: "/sessions/codex", tier: 2, exists: true, shape: false }],
  [{ host: "codex-cli", path: "/bin/codex", exists: true, origin: "command" }],
);

assert.deepEqual(catalog.harnesses.filter(({ detected }) => detected).map(({ id }) => id), ["codex"]);
assert.deepEqual(catalog.hosts.map(({ id }) => id), [...REVIEWED_SESSION_HOSTS]);
assert.deepEqual(catalog.hosts.filter(({ detected }) => detected).map(({ id }) => id), ["codex-cli"]);

const preserved = buildSessionCatalogReview([], [], KNOWN_TRANSCRIPT_FORMATS.filter((format) => format !== "pi"));
assert.equal(preserved.harnesses.find(({ id }) => id === "pi")?.selected, false, "catalog re-entry preserves an existing ignore");
const reenabled = await reviewSessionCatalog({
  mode: "rpc",
  ui: { async input(): Promise<string> { return "+pi"; } } as any,
}, preserved);
assert.ok(reenabled?.selectedFormats.includes("pi"), "RPC can explicitly re-include a previously ignored harness");
assert.ok(reenabled?.defaultFormats.includes("pi"), "re-including a harness restores its standard stores");

let rpcInputs = 0;
const rpcWarnings: string[] = [];
const correctedRpc = await reviewSessionCatalog({
  mode: "rpc",
  ui: {
    async input(): Promise<string> { return rpcInputs++ === 0 ? "claude" : "claude-code"; },
    notify(message: string): void { rpcWarnings.push(message); },
  } as any,
}, catalog);
assert.equal(rpcInputs, 2, "unknown RPC consent IDs are rejected and re-prompted");
assert.match(rpcWarnings[0] ?? "", /unknown.*claude/i);
assert.ok(!correctedRpc?.selectedFormats.includes("claude"));

const relocated = buildSessionCatalogReview(
  [
    { source: "claude", root: "/relocated/claude", tier: 1, exists: true, shape: false },
    { source: "claude", root: "/standard/claude", tier: 2, exists: true, shape: false },
  ],
  [],
  ["claude"],
  [],
);
const relocatedResult = await reviewSessionCatalog({
  mode: "rpc",
  ui: { async input(): Promise<string> { return ""; } } as any,
}, relocated);
assert.deepEqual(relocatedResult?.selectedFormats, ["claude"]);
assert.deepEqual(relocatedResult?.defaultFormats, [], "a prior standard-store ignore remains in force");
assert.deepEqual(relocatedResult?.roots, [{ format: "claude", root: "/relocated/claude" }], "an explicitly relocated store remains authorized");

let inventory = "";
const result = await reviewSessionCatalog({
  mode: "rpc",
  ui: {
    async input(title: string): Promise<string> { inventory = title; return "claude-code, pi"; },
    custom(): never { throw new Error("RPC must use the single-prompt fallback"); },
  } as any,
}, catalog);
assert.ok(inventory.includes("Claude App") && inventory.includes("Claude CLI"));
assert.ok(inventory.includes("Codex App") && inventory.includes("Codex CLI"));
assert.deepEqual(
  result?.selectedFormats,
  KNOWN_TRANSCRIPT_FORMATS.filter((format) => format !== "claude" && format !== "pi"),
  "one answer marks ignored harnesses while every other format stays selected",
);

let customCalls = 0;
const deepRoot = "/archive/.codex/sessions";
const tuiUi = {
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => component.handleInput(customCalls++ === 0 ? "s" : "\r"));
    });
  },
  async select(): Promise<undefined> { return undefined; },
  async input(): Promise<undefined> { return undefined; },
  notify(): void {},
};
const searched = await reviewSessionCatalog({ mode: "tui", ui: tuiUi as any }, catalog, {
  searchMore: async () => buildSessionCatalogReview(
    [{ source: "codex", root: deepRoot, tier: 3, exists: true, shape: true }],
    [],
  ),
});
assert.ok(searched?.roots?.some(({ format, root }) => format === "codex" && root === deepRoot), "bounded deep search updates the same review surface");

customCalls = 0;
const manualRoot = "/external/codex-sessions";
const manualUi = {
  ...tuiUi,
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => component.handleInput(["a", "s", "\r"][customCalls++]));
    });
  },
  async select(): Promise<string> { return "codex"; },
  async input(): Promise<string> { return manualRoot; },
};
const manual = await reviewSessionCatalog({ mode: "tui", ui: manualUi as any }, catalog, {
  searchMore: async () => buildSessionCatalogReview(
    [{ source: "codex", root: deepRoot, tier: 3, exists: true, shape: true }],
    [],
  ),
});
assert.ok(manual?.roots?.some(({ format, root }) => format === "codex" && root === manualRoot), "manual store entry returns to the same review surface");
assert.ok(manual?.roots?.some(({ format, root }) => format === "codex" && root === deepRoot), "deep search merges without dropping a manual store");

customCalls = 0;
const cancelWarnings: string[] = [];
await reviewSessionCatalog({ mode: "tui", ui: {
  ...tuiUi,
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => component.handleInput(customCalls++ === 0 ? "a" : "\r"));
    });
  },
  async select(): Promise<string> { return "codex"; },
  async input(): Promise<undefined> { return undefined; },
  notify(message: string): void { cancelWarnings.push(message); },
} as any }, catalog);
assert.deepEqual(cancelWarnings, [], "cancelling manual store entry is not reported as invalid input");

const missingRoot = "/future/store";
const missingWarnings: string[] = [];
let missingRender: string[] = [];
customCalls = 0;
const missingResult = await reviewSessionCatalog({ mode: "tui", ui: {
  ...tuiUi,
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => {
        if (customCalls++ === 0) component.handleInput("a");
        else {
          missingRender = component.render(240);
          component.handleInput("\r");
        }
      });
    });
  },
  async select(): Promise<string> { return "codex"; },
  async input(): Promise<string> { return missingRoot; },
  notify(message: string): void { missingWarnings.push(message); },
} as any }, buildSessionCatalogReview([], []), { pathExists: () => false });
assert.ok(missingResult?.roots.some(({ format, root }) => format === "codex" && root === missingRoot), "a future absolute store remains configurable");
assert.match(missingWarnings[0] ?? "", /does not exist/i, "a missing manual store is disclosed");
assert.ok(!missingRender.join("\n").includes(`detected at ${missingRoot}`), "a missing manual store is not presented as detected");

let detectedRender: string[] = [];
await reviewSessionCatalog({ mode: "tui", ui: {
  ...tuiUi,
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => {
        detectedRender = component.render(80);
        component.handleInput("\r");
      });
    });
  },
} as any }, buildSessionCatalogReview([
  { source: "claude", root: "/stale/claude", tier: 1, exists: false, shape: false },
  { source: "claude", root: "/actual/claude", tier: 2, exists: true, shape: false },
], []));
assert.ok(detectedRender.join("\n").includes("detected at /actual/claude"), "the displayed detection path is one that exists");
assert.ok(detectedRender.every((line) => visibleWidth(line) <= 80), "every catalog row fits an 80-column terminal");

const explicitOnlyRoot = "/standard/claude";
customCalls = 0;
const explicitOnly = await reviewSessionCatalog({ mode: "tui", ui: {
  ...tuiUi,
  custom(factory: any): Promise<any> {
    return new Promise((resolve) => {
      Promise.resolve(factory(
        { requestRender(): void {} },
        { fg: (_color: string, value: string): string => value },
        {},
        resolve,
      )).then((component) => {
        if (customCalls++ === 0) {
          component.handleInput(" ");
          component.handleInput("a");
        } else component.handleInput("\r");
      });
    });
  },
  async select(): Promise<string> { return "claude-code"; },
  async input(): Promise<string> { return explicitOnlyRoot; },
} as any }, buildSessionCatalogReview([
  { source: "claude", root: explicitOnlyRoot, tier: 2, exists: false, shape: false },
], []), { pathExists: () => false });
assert.ok(explicitOnly?.selectedFormats.includes("claude"));
assert.ok(!explicitOnly?.defaultFormats.includes("claude"), "adding one explicit store after ignoring a harness does not restore standard stores");
assert.ok(explicitOnly?.roots.some(({ format, root }) => format === "claude" && root === explicitOnlyRoot), "a manually authorized standard path remains explicit");

process.stdout.write("ok — session catalog review: inventory, preserved choices, deep search, manual store, RPC fallback\n");
