// Hand-written declarations for gui-hosts.mjs (plain ESM so the scan skill can import it
// without a build step). Keep in lockstep with gui-hosts.mjs.

/** An interactive GUI a session can be launched from, matched by cwd marker and/or source. */
export interface GuiHost {
  /** Canonical app name shown in session state (e.g. "Conductor", "Superset App"). */
  ui: string;
  /** Substring of the session cwd that identifies the GUI's worktree dir. */
  cwdMarker?: string;
  /** Absolute configured roots (v3 canonical representation). */
  roots?: readonly string[];
  /** Legacy substring markers retained for gui_hosts.json compatibility. */
  cwdMarkers?: readonly string[];
  /** Session source this GUI owns (e.g. "posthog-code"). */
  source?: string;
  /** Surface even with zero conversation (e.g. PostHog Code cloud tasks still provisioning). */
  surfaceEmpty?: boolean;
}

/** Built-in hosts plus owner `add`s from <ooHome>/gui_hosts.json. Never throws. */
export function loadGuiHosts(ooHome?: string): GuiHost[];

/** The GUI a cwd physically lives in (path-marker hosts only), or null. */
export function guiHostForCwd(cwd: string | null | undefined, hosts?: GuiHost[]): GuiHost | null;

/** The interactive host for a session — cwd marker (worktree wins) or source — else null. */
export function interactiveHost(cwd: string | null | undefined, source: string, hosts?: GuiHost[]): GuiHost | null;
