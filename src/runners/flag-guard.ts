// Runner-internal: builds the flag-denylist guard shared by claude()/codex().
// Two copies of this security-relevant guard used to live inline in each runner;
// keeping the matching semantics single-sourced here prevents divergence between
// them. Each runner still owns its denylist CONTENT and passes it in.
//
// Not exported from the public barrel (`src/runners/index.ts` / `src/index.ts`).
export function makeFlagGuard(
  runnerName: string,
  denylist: readonly string[],
): (flag: string) => void {
  return (flag: string): void => {
    for (const deny of denylist) {
      if (flag === deny || flag.startsWith(`${deny}=`)) {
        throw new Error(`${runnerName}(): flag "${flag}" is on the denylist`)
      }
    }
  }
}
