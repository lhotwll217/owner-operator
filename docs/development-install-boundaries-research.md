# Development and installed-runtime boundaries

## Conclusion

Owner Operator currently has a coherent **development topology**, not a release-like installed
topology. The `oo` on `PATH`, the daemon LaunchAgent, and the widget LaunchAgent all resolve into
one mutable checkout. That is useful for dogfooding, but it is not visibly distinguished from an
official install, and the long-lived services inherit changes from that checkout.

The important boundary is not “source is bad.” It is:

1. code and shipped resources come from one identifiable source or artifact;
2. the service records exactly which entrypoint and version it owns;
3. runtime workspace/context is an explicit input, not an accidental consequence of the code path;
4. durable user state is outside the code installation; and
5. development and release-like modes are named, diagnosable, and intentionally selected.

OpenClaw implements these seams without requiring every developer to use a packaged release.
Owner Operator should borrow the observability and mode distinction, then add a packaged dogfood
lane incrementally. It does not need an installer rewrite before fixing ambient context loading.

## Where Owner Operator is now

The observed local installation on 2026-07-13 is:

- `/opt/homebrew/bin/oo` resolves through npm's global package directory to the checkout at
  `/Users/otwell/Development/owner-operator`. This is exactly what `npm link` is for: npm describes
  it as a global symlink to a package folder for iterative development
  ([npm documentation](https://docs.npmjs.com/cli/v11/commands/npm-link/)).
- The launcher resolves that symlink back to the checkout and executes `src/cli/oo.ts` or
  `src/cli/interactive.ts` through the checkout's `tsx`
  ([launcher](../oo#L8-L34)). The package is also private and reports version `0.0.0`
  ([package metadata](../package.json#L1-L10)).
- The widget installer builds inside the checkout, then writes LaunchAgents whose entrypoints are
  the checkout's `.build/release/oo-widget` and `$ROOT/oo`; the daemon working directory is also
  `$ROOT` ([installer](../apps/widget/dev/install.sh#L6-L48)).
- Durable state is already separated correctly: `OO_HOME` or `~/.owner-operator` owns the database,
  discovery file, log, and sessions ([state paths](../src/shared/paths.ts#L1-L7),
  [session policy](../src/agent/agent.ts#L165-L180)).
- The daemon's content fingerprint is a strong development convenience: it hashes runtime source,
  package metadata, lockfile, and Pi settings, including uncommitted edits
  ([fingerprint](../src/daemon/fingerprint.ts#L6-L40)). It answers “did the checkout change?”, but it
  is not an installed artifact version or provenance record.
- The eval subject is deliberately isolated with `OO_EVAL_CWD` and a separate `OO_HOME`
  ([eval invocation](../eval/providers/pi-agent-core.mjs#L209-L227)).

This means a source edit can change the next CLI invocation immediately and can make the daemon
restart against new code. The widget changes only after a rebuild/reinstall because launchd points
at a built file in `.build`. These are reasonable development mechanics; the problem is that the
system does not state that it is in development mode or provide a release-like alternative.

The `AGENTS.md` incident is related but independently fixable. Pi's `noContextFiles: true` should
still be set for the product agent. Packaging alone would merely move or hide the accidental input;
it would not define the prompt boundary. See [Agent runtime context boundaries](agent-runtime-context-boundaries-research.md).

## What OpenClaw standardizes

### Explicit source and package modes

OpenClaw's installer has an explicit `npm|git` install method and, when it detects a source checkout,
asks whether to keep using it or migrate to npm
([installer](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/scripts/install.sh#L1200-L1213),
[checkout choice](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/scripts/install.sh#L1354-L1423)).
Its source loop runs TypeScript through `tsx`, while builds produce `dist` for Node and packaged
execution
([source development](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/README.md#L225-L259)).

It also separates two meanings of development:

- `--dev` is an isolated runtime profile: state/config move to `~/.openclaw-dev` and the gateway
  uses port `19001`
  ([profile implementation](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cli/profile.ts#L73-L109)).
- The `dev` update channel is a persistent moving source checkout. Switching between it and package
  channels changes the code installation while retaining state, config, credentials, and workspace
  under `~/.openclaw`
  ([update contract](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/install/updating.md#L59-L100)).

This is the useful tension resolution: an isolated source loop for experimentation, plus an
explicit dogfood channel that can use real durable state.

### Services record and expose what they run

For ordinary installs, OpenClaw resolves a built `dist` entrypoint and prefers a stable package
symlink over a version-specific realpath so service definitions survive package updates. Direct
TypeScript execution and a checkout working directory are a separate dev path
([program arguments](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/program-args.ts#L23-L79),
[dev path](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/program-args.ts#L214-L292)).
The installed service environment includes an OpenClaw marker, service kind, and installer version
([service stamp](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-env.ts#L413-L446)).

Status inspection does not trust a friendly version string alone. It reads the supervisor command,
resolves the entrypoint and realpath, finds the package root and version, and identifies whether the
entrypoint comes from a source checkout
([layout summary](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-layout.ts#L123-L157)).
Doctor then reports source-checkout services, entrypoint drift, installer-version drift, and CLI vs
running-gateway version skew
([source and entrypoint checks](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/commands/doctor-gateway-services.ts#L499-L505),
[entrypoint mismatch](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/commands/doctor-gateway-services.ts#L577-L595),
[version audit](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/daemon/service-audit.ts#L606-L617),
[runtime skew](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/commands/doctor-gateway-health.ts#L46-L58)).
Its updater uses the same distinction, reports install kind plus git branch/tag/SHA, coordinates
service restart, and keeps package trees read-only at runtime
([status implementation](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/src/cli/update-cli/status.ts#L43-L109),
[update guidance](https://github.com/openclaw/openclaw/blob/372b527da4a1cee5b819e7852f6e26ef11160e85/docs/install/updating.md#L125-L166)).

The standard to borrow is therefore: **inspect the real entrypoint, stamp the service, and show the
mode**. A launchd plist's `WorkingDirectory` is execution configuration, not proof of provenance.

## Staged recommendation

1. **Fix the product-context boundary now.** Set Pi's `noContextFiles: true` in the shared Owner
   Operator loader and test every surface. This is small and does not depend on packaging.
2. **Make the current topology honest.** Add one read-only diagnostic (`oo doctor` or
   `oo status --json`) that reports: install kind (`linked-source`, `source`, or `package`), CLI
   path and realpath, package root, git commit and dirty state when applicable, product version,
   daemon/widget entrypoints and realpaths, service stamp, runtime fingerprint, `OO_HOME`, and
   runtime cwd/context-file policy. Show a short `dev/source` marker in interactive startup.
3. **Name the source lane.** Keep `npm link` as a supported developer command, but install services
   under explicit dev labels (for example `com.owner-operator.dev.*`). Default that lane to an
   isolated `OO_HOME` or require an explicit `--use-production-state` choice when dogfooding against
   real state. This makes risk visible without preventing useful dogfooding.
4. **Add a release-like dogfood artifact.** Build the Node CLI into distributable JavaScript and the
   widget into a versioned staging directory, stamp both with package version + git commit, and have
   the non-dev LaunchAgents point only there. A local packed artifact is enough initially; signing,
   notarization, and an updater can follow when distribution requires them.
5. **Keep state continuous, migrate deliberately.** Code installs may switch while
   `~/.owner-operator` remains stable, but the state schema must record its version and reject or
   migrate incompatible downgrades. Evals continue using isolated state and cwd.
6. **Add updates last.** Once an immutable artifact and diagnostic manifest exist, add an atomic
   install/swap and coordinated service restart. Do not build a self-updater around the current
   mutable checkout.

This preserves the parts already working well—one durable user-state home, launchd supervision,
the runtime fingerprint, and eval isolation—while creating a clear answer to “what am I running?”
before investing in release machinery.
