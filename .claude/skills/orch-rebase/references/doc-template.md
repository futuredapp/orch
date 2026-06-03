# Run-doc template

Write this to `.orch/rebase/<slug>.md` (gitignored, so it never dirties the main
worktree) in phase 4 and keep it updated as a running
log through phase 5. It's the single source of truth for the run — what was
decided, why, and what happened — so a later reader (or you, after a crash) can
reconstruct the state.

```markdown
# Rebase + merge run: <slug>

- **Date:** <YYYY-MM-DD HH:MM>
- **Base:** main @ <sha-before>
- **Targets:** feat/a, feat/b, feat/c
- **Backups:** orch-backup/<slug>/* (restore: `scripts/restore-backup.sh <slug> feat/a feat/b feat/c`)

## Worktree summaries

### feat/a
What it does / what it changes / risk notes. (from analysis subagent)

### feat/b
...

## Conflict prediction

- vs main: feat/a CLEAN, feat/b CONFLICTS (src/x.ts), ...
- shared files: feat/a × feat/b → src/x.ts, src/y.ts

## Decided order & rationale

1. feat/b — least entangled, lands first
2. feat/a — shares src/x.ts with feat/b; after b lands, watch src/x.ts:doThing()
   because b changed its signature and a calls it
3. ...

### Interaction warnings
- **feat/a after feat/b:** b renamed `doThing` → `doThingV2`; a still calls
  `doThing`. Expect a rebase conflict / verify failure in src/x.ts; reconcile to
  the new name.

## Run log

- [ ] feat/b — rebase: …  merge: …  verify: …
- [ ] feat/a — rebase: …  merge: …  verify: …  fixes: …

## Result

main @ <sha-after>. Merged: feat/b, feat/a. Skipped: none.
```

Keep it terse — checkboxes and one-liners. The value is the **interaction
warnings** and the **run log**, which together let anyone see what changed and
why a given conflict was expected.
```
