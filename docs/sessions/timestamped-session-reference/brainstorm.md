---
date: 2026-04-29
topic: timestamped-session-reference
---

# Timestamped run ID + path-on-completion

## What We're Building

When `orch run` finishes, the user wants two things they don't have today:

1. The **run ID itself** should encode date **and** time, so the ID is human-readable as a timestamp at a glance.
2. The **full relative path** to the run's session data on disk should be printed at the end of every run (success **and** failure), so users can immediately `cd`/`tail` into it without recomputing the path from the ID.

Today the ID format is `r-YYYY-MM-DD-xxxxyy` (date + 4 clock-derived + 2 crypto-random base-36 chars), and the only end-of-run output is `Workflow "<name>" completed.` with no ID and no path.

## Why This Approach

We considered three scopes (format-only, output-only, both) and the user picked "change the format **and** also print the path on completion." Embedding the time directly in the ID makes the directory name self-explanatory; printing the path at the end removes the last bit of friction (mentally prefixing `.orch/state/`).

For the format we considered ISO-T-style, compact `YYYYMMDD`, and an extension of the current dashed style. The current style won — minimal visual change, smallest blast radius for users skimming logs.

For backward compat we considered union-regex, hard cutover, and a one-shot migrator. **Hard cutover** won: this is a developer tool, the user is fine deleting `.orch/state/`, and a regex union would be load-bearing forever for a one-time UX improvement.

## Key Decisions

- **New ID format: `r-YYYY-MM-DD-HHMMSS-xx`** — six-char `HHMMSS` time segment inserted between date and a 2-char base-36 crypto suffix. Example: `r-2026-04-29-143052-7k`.
  - Rationale: extends the existing dashed style; segment boundaries stay obvious; `HHMMSS` is the shortest unambiguous time form that survives copy/paste and Windows filenames.
- **Local time, not UTC.** The ID matches the user's wall clock when they ran the command. Trade-off accepted: IDs from different machines/timezones aren't directly comparable, and `HHMMSS` is briefly ambiguous twice a year around DST fall-back.
  - Mitigation: the 2-char crypto suffix still disambiguates collisions inside the DST-overlap hour.
- **Keep a 2-char crypto suffix** — avoids same-second collisions for scripted/parallel invocations, ~1296 distinct values per second is plenty.
- **Hard cutover on the regex.** `RUN_ID_PATTERN` only matches the new format. Existing `r-YYYY-MM-DD-xxxxyy` directories under `.orch/state/` become invisible to `orch logs`, `orch resume`, and `RunRegistry`. User is expected to clean them up manually.
- **Print path on success AND failure**, end-of-run only (not at start — start already prints the ID, and start-of-run noise is already high). Format:
  ```
  Workflow "foo" completed.
    data: .orch/state/r-2026-04-29-143052-7k/
  ```
  And on failure:
  ```
  Workflow "foo" failed: <reason>
    data: .orch/state/r-2026-04-29-143052-7k/
  ```
- **Path is relative to cwd**, matching how `.orch/state/` is already addressed in the codebase (`statePath`).

## Open Questions

- Where exactly does the failure-path message live today? `executeWithAttach` only handles success via `onSuccess`; the failure string is emitted somewhere else (likely by the host or by `mapRunError`'s caller). The plan phase needs to identify the single seam where "Workflow … failed" is printed and ensure the path appendix lands there too. If there isn't a single seam, we may need to introduce one.
- Tests that assert the exact `RUN_ID_PATTERN` regex or hard-coded ID samples (`r-2026-04-29-tvmshp` style) will need updating. Scope of fan-out is unknown until the plan phase greps for it.
- Do we want a `Z`/`L` marker in the ID to make local-vs-UTC explicit (e.g., `r-2026-04-29-143052L-7k`)? **Decision deferred** — not asked, not raised by the user, and YAGNI for a single-tz developer tool. Revisit only if multi-machine ID confusion becomes a real complaint.

## Next Steps

→ `/workflows:plan` to produce the implementation plan (regex, `generateRunId`, end-of-run print sites, test updates).
