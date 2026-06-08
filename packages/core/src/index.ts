// Owner Operator — shared domain model.
//
// UI-INDEPENDENT by design: the harness *produces* this data; every surface (TUI, web,
// widget, another agent, a script) *consumes* it. No colors, no layout, no terminal, no
// engine deps. This is the contract the headless output and all renderers agree on — the
// "structured data is the product; UIs are renderers" split the pi ecosystem uses.

/** One active agent thread, triaged. The headless unit of data every surface renders. */
export interface Thread {
  /** Short title of what the thread is about. */
  topic: string;
  /** 5 (highest — needs the operator now) down to 1 (lowest). */
  priority: number;
  /** One sentence on what has generally happened / current state. */
  summary: string;
  /** One short clause: the concrete next action. */
  nextSteps: string;
  /** Repo name. */
  repo: string;
  /** App / GUI the session was made from. */
  app: string;
  /** Relative time created, e.g. "2 hours ago". */
  created: string;
  /** Relative time of the last message, e.g. "just now". */
  lastActive: string;
  /** Deep link to open the session, if known. */
  link?: string;
}

/** A full triage snapshot: the active threads. Most-urgent first by convention. */
export type Triage = Thread[];

/** Order threads loudest-first (priority 5 → 1). Pure, so every surface shares one ordering. */
export function sortByPriority(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
