# Development — dev mode vs. local install

How to run Owner Operator on your machine: **run from source while you work (dev)** vs.
**put the `oo` command on your PATH (local install)**. Plus the conventions we borrow from
the pi ecosystem (pointers in [inspiration.md](./inspiration.md)).

## Two ways to run

First time only: `npm install` from the repo root — installs the workspace, hoisting `tsx`
and the `@earendil-works/pi-*` deps to the root `node_modules`.

### Dev — run from source (no build)

`tsx` runs the TypeScript directly, so edits are live — no rebuild step.

```bash
./harness/oo                      # branded TUI (interactive)
./harness/oo "what's ongoing?"    # one-shot
npm run oo  -w harness            # same one-shot via the workspace script
npm run tui -w harness            # same TUI
```

### Local install — `oo` on your PATH

```bash
cd harness && npm link            # `oo` now available anywhere (still runs your checkout)
oo "what's ongoing?"
npm rm -g @owner-operator/harness # unlink
```

The `bin: oo` entry runs source via `tsx`, so a linked `oo` is your live checkout — not a
frozen copy. A compiled, publishable install (`npm i -g`) comes later (see below).

## Conventions we borrow (pi ecosystem)

- **pi** — dev = a `tsx` wrapper on `src/cli.ts` (no watch daemon); published install =
  compiled `dist/cli.js` behind a `bin`. Exact-pinned deps, npm workspaces, lockstep
  versioning. It runs the **pinned** `node_modules/.bin/tsx`, not `npx`, so tsx resolves
  from the checkout rather than the caller's cwd.
- **OpenClaw** — one self-aware bin detects a source checkout (`.git` / `src/entry.ts`), so
  the *same* command runs dev (tsx + watch) or prod (packaged `dist/`). Release channels
  `stable | beta | dev`. Gateway-as-control-plane; thin surfaces (CLI / TUI / web / apps)
  talk to it over a typed protocol; channels & skills are plugins.
- **Hermes** — editable install + symlink the bin into `~/.local/bin` (their "no watch
  step" — editable = live source); feature-gated extras so users install only what they
  need. **Profile isolation** (`-p <name>` → separate home / config / sessions / PID) for
  running many agents at once; a platform-agnostic core (one agent class behind
  CLI / gateway / cron entry points).

## What we adopt — pragmatically

- **Now:** `npm install`, then dev via `./harness/oo` / `npm run`, or local install via
  `npm link`. The `oo` launcher resolves its own symlink and prefers the checkout's `tsx`
  (pi's pattern), so a linked `oo` runs the live checkout from any directory — verified
  end-to-end. Lean: no build step until we need one.
- **Later, when there's a reason:** a `dist/` build + self-detecting bin (OpenClaw) for a
  publishable `npm i -g`; release channels; profile isolation (Hermes) once we run many
  operators at once.
