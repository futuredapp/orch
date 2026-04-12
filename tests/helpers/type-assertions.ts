/**
 * Compile-time type equality utilities.
 *
 * Same pattern as TypeScript compiler's own test suite and type-fest.
 * Usage: `type _1 = Expect<Equal<Actual, Expected>>`
 * Fails at compile time if types diverge — zero runtime cost.
 */

export type Expect<T extends true> = T

export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
