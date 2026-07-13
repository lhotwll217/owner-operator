import assert from "node:assert";
import { KNOWN_TRANSCRIPT_FORMATS, REVIEWED_SESSION_HOSTS } from "@owner-operator/core";
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

process.stdout.write("ok — session catalog review: inventory, preserved choices, deep search, manual store, RPC fallback\n");
