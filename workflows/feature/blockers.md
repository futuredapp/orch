BLOCKER PROTOCOL — read carefully.

Have you found a critical issue that prevents you from continuing, or that contradicts the
brainstorm and is critical enough that the developers must know about it before any more work
happens? If so, stop as soon as possible and write it down to
`{{sessionsDir}}/blockers/{{blockerFile}}`.

Be very careful with this: raising a blocker STOPS the implementation workflow you are part of —
the user will have to review your finding and decide how to proceed before the workflow
continues. So do NOT raise a blocker for anything minor, cosmetic, or that you can reasonably
work around yourself.

ONLY raise a blocker for things like:
- An assumption made in the brainstorm turns out to be totally wrong.
- We assumed something was possible, but it is actually not possible.
- This work depends on something else being implemented first, and that something is not part of
  this implementation / out of scope.

If you do raise a blocker, write it to `{{sessionsDir}}/blockers/{{blockerFile}}` with a clear,
self-contained description (what you found, why it blocks, what you think should happen) that a
developer with no prior context can understand. Then stop your current work. If you found NO such
blocker, do not create the file at all and continue normally.
