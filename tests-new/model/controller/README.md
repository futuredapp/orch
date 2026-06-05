# `model/controller` — a category, not a `scenario()`

The right-pane-controller / pane-map tests instantiate
`createRightPaneController(...)` directly and assert its **decisions** at the
`FakeTmuxService` seam — which session it swaps to, what it writes to the overlay,
when it refuses to swap to a dead pane. They never read a rendered pane.

By the parent plan's triage rule (*"would this test still pass if the visible pane
were empty / wrong / unformatted?"*) the answer is **yes** — the risk is the
decision, not the bytes. So these belong in the `unit` row of the decision rule,
not in `screen`/`full-host` rendering scenarios.

The `model` driver renders **only** the left-pane `StepsView` (`ModelApp.leftPane`,
no `rightPane`), so it provably cannot back a right-pane-controller decision
surface. Rather than invent an unbacked `ControllerApp` scenario envelope, this
directory follows the **`tmux-argv` precedent** (parent §5.2): a category directory
of plain `it()` tests, no `scenario()`, no driver. The category directory **is** the
taxonomy slot; the plain test **is** the readable form.

Shared fixtures live in [`_support.ts`](./_support.ts). Pure helper logic on
`projectStepsView` / `applySubworkflowEvent` lives in the sibling
[`../projector/`](../projector) category, same non-`scenario()` shape.
