# Fix Group E — Make AT-6's OSC 52 "escaped, not executed" guarantee falsifiable

Status: **done**

Findings addressed: CE H-1 (high) — the highest-priority finding in the fix plan.
All other groups (A–D) were already `done` on entry; this round closed the last
remaining group.

## What was wrong

AT-6's contract (`docs/sessions/show-initial-prompt/acceptance-tests.md:51-52`)
requires the OSC 52 sub-case to assert the decoded clipboard payload does **not**
reach the terminal clipboard. The test
(`tests/full-host/fake-agent/prompt-preamble--control-sequences-escaped.test.ts`)
only asserted (a) the base64 payload shows as visible text and (b)
`assertNoOsc52()` (raw `\x1b]52` bytes absent from pane *text*). Both could pass
whether or not the OSC 52 executed against a clipboard — the guarantee held in
production but the test could not fail if it were violated. A test-fidelity gap,
not a product defect.

## What I changed

Added a real clipboard observation, in its lightest compliant form (the contract's
"a clipboard check (or harness clipboard stub)"): read the tmux paste buffer and
assert the decoded payload is absent. Under the appliance config's
`set-clipboard on`, a passed-through OSC 52 would populate a server paste buffer
with the decoded body — so reading that buffer is genuinely falsifiable.

Production (subprocess isolation honored — routed through the `TmuxService` port,
never a direct tmux call):

- `src/services/tmux/tmux-service.ts` — new `ShowPasteBuffersOptions` + read-only
  `showPasteBuffers(opts): Promise<string>` on the `TmuxService` port (returns the
  concatenated contents of all server paste buffers, `''` when none).
- `src/services/tmux/real-tmux-service.ts` — implementation: `list-buffers -F
  '#{buffer_name}'` (exits 0 / empty when none) then `show-buffer -b <name>` per
  buffer, joined.
- `src/services/tmux/fake-tmux-service.ts` — `showPasteBuffers` recorded call +
  `setPasteBuffersResult(...)` scripted-return queue (defaults to `''`).
- `src/services/tmux/index.ts` — export the new options type.

Test harness (DSL):

- `tests/dsl/panes/pane-driver.ts` — new optional `assertClipboardUnchanged?(payload)`
  capability (real-tmux only).
- `tests/dsl/drivers/real-tmux-pane-driver.ts` — new optional `clipboard: { tmux,
  socket }` dep; when wired, exposes `assertClipboardUnchanged` (reads
  `showPasteBuffers`, throws if the payload is present). When absent, the
  capability is omitted so the Pane Object falls back to `notImplemented`.
- `tests/dsl/drivers/full-host-static-app.ts` and
  `tests/dsl/drivers/full-host-fake-agent-driver.ts` — pass
  `clipboard: { tmux: fixture.tmux, socket: fixture.socket }` into the pane driver.
- `tests/dsl/panes/right-pane.ts` — new `assertClipboardUnchanged(payload)` Pane
  Object method (forwards to driver; `notImplemented` elsewhere).

Tests:

- `tests/full-host/fake-agent/prompt-preamble--control-sequences-escaped.test.ts`
  — the AT-6 scenario now also calls
  `await app.rightPane.assertClipboardUnchanged('clipboard-payload')`.
- `tests/integration/services/tmux/tmux-real.integration.test.ts` — two focused
  real-tmux tests pinning the new production seam directly: `showPasteBuffers`
  returns `''` with no buffers, and returns the decoded payload after a pane emits
  a bare OSC 52 under `set-clipboard on`.

Docs:

- `docs/sessions/show-initial-prompt/fix-plan.md` — Group E `Status: done`.
- `docs/sessions/show-initial-prompt/acceptance-tests.md` — AT-6 Notes updated to
  record the new clipboard assertion and its falsifiability.

## Falsifiability — verified empirically (the plan's gate for closing AT-6)

1. Confirmed at the tmux level first: a pane process that emits a bare OSC 52 under
   `set-clipboard on` populates `buffer0: "clipboard-payload"`, readable via
   `list-buffers` / `show-buffer`, even on a detached session — which is exactly
   how the production `tail -F` source pane would feed prompt bytes.
2. Temporarily disabled the escaper (`renderPromptPreamble` returning the raw
   prompt) and reordered the scenario so the clipboard assertion ran first: it went
   **red** with `tmux paste buffer contains the OSC 52 payload "clipboard-payload"`
   — proving the assertion observes real clipboard state, not pane text. Both the
   escaper and the test were then restored; the scenario passes green.

## Verification

- `bun run typecheck` — clean.
- `bun run lint` (biome) — clean.
- `bun test tests/unit` — 1923 pass / 0 fail.
- `bun run test:two-pane:fast` — 295 pass / 0 fail.
- `bun test tests/integration/services/tmux/tmux-real.integration.test.ts` — 29
  pass / 0 fail (was 27; +2 new).
- `bun test tests/dsl/drivers/__tests__/full-host-fake-agent-driver.test.ts
  tests/full-host/fake-agent` — 20 pass / 0 fail (AT-6 green).

## Issues hit

- Initial manual tmux probe via `send-keys 'printf …'` showed "no buffers" — the
  interactive pane shell hadn't executed the typed command. Running the OSC 52 as
  the pane's own startup command resolved it and matches the production source-pane
  byte path, so the integration test uses the command-emitter form.

## Notes / scope

- All five groups (A–E) of `fix-plan.md` are now `Status: done`.
- The fix adds a method to the `TmuxService` port that is currently test-only. This
  is the architecturally clean path the fix plan sanctioned ("routed through
  `ProcessService` / `RealTmuxService`, never a direct tmux call"): it keeps the
  real-tmux harness off a raw tmux subprocess and inside the existing port, with
  full `RealTmuxService` + `FakeTmuxService` parity.
