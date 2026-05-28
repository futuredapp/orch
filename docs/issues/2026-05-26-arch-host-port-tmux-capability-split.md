---
date: 2026-05-26
status: open
area: src/hosts
type: architecture
recommendation: worth-exploring
dependency-category: ports-and-adapters
---

# Split the Host port — tmux-only methods into an optional capability

## Problem

The `Host` interface (`src/hosts/host.ts`) carries 11 methods. Four of them
exist only for tmux's pane / attach / reachability lifecycle, and the plain host
implements all four as no-ops or constants:

- `attach(pane)` → returns a no-op detach closure (`plain-host.ts:150`)
- `attachForeground()` → immediate return (`:173`)
- `awaitForegroundShutdown()` → hardcoded `'attach-exited'` (`:177`)
- `probeReachability()` → hardcoded `{ reachable: true }` (`:193`)

Roughly half of the interface's doc comments describe tmux semantics (panes,
attach clients, server death) that never run under plain. The interface is
shaped around tmux, not around the abstraction both adapters share. A reader
learning the port — or a third host author — wades through concepts that don't
apply.

## Files

- `src/hosts/host.ts` — the 11-method interface and its `InteractiveSpawn`
  (`pane`, `autoStop` fields are also tmux-only)
- `src/hosts/plain/plain-host.ts:150,:173,:177,:193` — the four no-op impls

## Solution

Keep the six shared methods on `Host` (`writeBanner`, `onRunnerEvent`,
`onLifecycleEvent`, `onCommandLine`, `runInteractive`, `teardown`). Move the
foreground / attach / reachability four behind an optional `ForegroundSession`
the CLI launcher obtains when the host provides one. Plain provides none; the
CLI branches once on its presence instead of calling four no-ops.

## Wins

- Interface shrinks to what both adapters actually share
- Plain host stops carrying dead weight
- A third host inherits no tmux concepts

## Trade-off (why not Strong)

Only tmux needs the capability today — one adapter is a *hypothetical* seam, not
a proven one. The win is the shrunk shared interface, not a second adapter, and
the CLI's attach-vs-workflow race logic must move with the capability. Weigh
that cost before committing.

## Recommendation strength

**Worth exploring.**
