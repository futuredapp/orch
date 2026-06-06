# The scenario/driver DSL

Write a behaviour **once** as a `scenario(meta, body)`; run it at multiple
fidelities by **listing drivers**, not by copy-pasting files. The four layers:

```
Scenario   a plain async (app) => { ... } ; Given/When/Then are await statements
   │       lists which drivers it runs on; carries metadata (id/feature/risk/overlapGroup)
   ▼
Pane Object LeftPane / RightPane / SystemAssertions — SEMANTIC methods backed by
   │        co-located chrome constants; driver-INDEPENDENT
   ▼
Driver     one per fidelity; owns gating, timeouts, teardown, predictability rules
   ▼
System     src/hosts/two-pane/** under test, at the chosen fidelity
```

Scenario files import **only** from `tests-new/dsl/index.ts`. They never name a
driver type, touch a `PaneDriver`, or mention `canRunRealTmux`/timeouts.

## The chrome/content rule (D10)

Expected **chrome** (footer hints, glyphs, labels) lives as a **co-located
constant on the Pane Object** (e.g. `LeftPane.TEXT`) and is asserted via a
semantic method (`assertQuitHintVisible()`). It is **never** inlined in a
scenario and **never** imported from `src/` — an imported production symbol on
both sides of an assertion is tautological and would survive a production typo.

Test-authored **content** uses the `assertShowsContent(text)` escape hatch — the
only free-string assertion.

A one-off layout test may inline a chrome literal **only** with an explicit
`// CHROME-LITERAL-EXCEPTION: <reason>` marker.

## Drivers (U1 status)

| Driver | Status | Lands |
|---|---|---|
| `model` | live | U1 |
| `tmux-argv` (category, not a `scenario()`) | live | U1 |
| `screen` | stub (skips) | parent U2 |
| `full-host:fake-agent` | stub (skips) | parent U2 |
| `lifecycle` | stub (skips) | parent U2 |
| `full-host:recorded-agent` | stub (skips) | parent U3 |
| `full-host:real-agent` | stub (skips) | parent U3 |

A scenario listing a stubbed driver is **skipped** at runtime (not failed), so
the convention can be adopted before every fidelity exists.
