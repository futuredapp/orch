// Shared marker for surfaces declared in U1 but wired by a later parent phase.
// Keeping the throw in one place makes "what is not built yet" greppable and
// gives a consistent, actionable message instead of a silent undefined.

export function notImplemented(feature: string): never {
  throw new Error(
    `${feature} is declared but not implemented yet — it lands in a later migration phase. ` +
      'If a scenario reached this, it listed a driver/surface this phase does not provide.',
  )
}
