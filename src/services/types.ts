// TODO(phase-3): relocate to src/core/types.ts. The brand shape is structurally
// identical, so every callsite keeps compiling after the move.
export type Path = string & { readonly __brand: 'Path' }

/** Unsafe cast. Phase 3 introduces validating smart constructors (path, pathAbs). */
export const path = (s: string): Path => s as Path
