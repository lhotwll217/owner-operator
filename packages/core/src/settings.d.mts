// Hand-written declarations for settings.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with settings.mjs.

/** Default active-thread window: a rolling 24h (`"1d"`), not calendar-"today". */
export const DEFAULT_ACTIVE_WINDOW: string;

/** Resolve a window spec (`Nh` | `Nd` | `today` | `YYYY-MM-DD`) to a cutoff in ms, or null. */
export function parseWindowMs(spec: string, nowMs: number): number | null;

/** True if `spec` is a window the scan understands (so config/onboarding can reject typos). */
export function isWindowSpec(spec: unknown): boolean;

/** The owner's active-thread window from <ooHome>/settings.json, else DEFAULT_ACTIVE_WINDOW. */
export function loadActiveWindow(ooHome?: string): string;
