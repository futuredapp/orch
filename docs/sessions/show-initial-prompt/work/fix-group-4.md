# Fix Group D — Close escaper / keying test-fidelity gaps

**Status:** done (Group D). Group E (AT-6 OSC 52 clipboard check) remains `not-started`.

## What this group was

Pure test-fidelity additions called for by `fix-plan.md` Group D — no production
change, so no behavioral regression risk. Three gaps in the prompt-preamble test
coverage:

- **M-3 (DEL):** `escapeCodePoint`'s dedicated DEL branch (`0x7F → U+2421 ␡`,
  `src/hosts/two-pane/prompt-preamble.ts:56`) had zero coverage — NUL/CR/BEL (C0)
  and `0x80–0x9F` (C1) were exercised, but never `0x7F`.
- **L-4 (surrogate adjacency):** the F4 unit test space-separated emoji from
  control bytes, so a surrogate-pair code unit immediately adjacent to an escaped
  control was never exercised.
- **L-3 (AT-3 negative):** `prompt-preamble--each-step-shows-own-prompt.test.ts`
  asserted step 1 shows `PROMPT-ALPHA` but never asserted `PROMPT-BRAVO` is
  **absent** — the contract (`acceptance-tests.md:29`) is two-directional.

## What I changed (tests only)

- `tests/unit/hosts/two-pane/prompt-preamble.test.ts`:
  - Added `DEL`/`DEL_PICTURE` constants.
  - New test: `escapeControlBytesToVisible('a\x7Fb')` drops `\x7F`, contains `␡`
    (U+2421), preserves `a`/`b`.
  - New test: `escapeControlBytesToVisible('🎉\x1b[2J🎉')` — emoji directly
    abutting ESC on both sides — keeps both 🎉 intact (asserted via
    `split('🎉')` having length 3, i.e. one emoji on each side of the escape),
    turns ESC into `␛`, and keeps the now-printable `[2J` payload.
- `tests/full-host/fake-agent/prompt-preamble--each-step-shows-own-prompt.test.ts`:
  - After reselecting the first step, added
    `await app.rightPane.assertDoesNotShow('PROMPT-BRAVO carry out the plan')`
    (the Pane Object already exposes `assertDoesNotShow`).

## Verification

- `bun test tests/unit/hosts/two-pane/prompt-preamble.test.ts` — 11 pass, 0 fail.
- `bun test --max-concurrency=4 tests/full-host/fake-agent/prompt-preamble--each-step-shows-own-prompt.test.ts`
  — 1 pass, 0 fail (real tmux).
- `bunx biome check` on both changed files — clean.

## Issues hit

None. All three additions match existing patterns in their files; the DSL helper
(`assertDoesNotShow`) and source escaper branches were already present, so this was
purely closing the assertion gaps. No production code touched.

## Remaining

- **Group E** (`not-started`) — make AT-6's OSC 52 "escaped, not executed"
  guarantee falsifiable via a real-tmux clipboard observation (new tmux service
  read method + driver plumbing). Not in scope for this round.
