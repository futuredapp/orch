// `PromptFileRegistry` — empty interface augmented by `.d.ts` sidecars that
// `orch types` (U7/U8) generates next to each `.md` / `.txt` prompt file.
//
// Pattern (lifted from TanStack Router's `FileRoutesByPath`): the package
// declares the empty interface; generated sidecars merge per-prompt-file
// entries via `declare module 'orch' { interface PromptFileRegistry { … } }`.
// `step.define({ promptFile: '@/…/x.md' })` then looks up
// `PromptFileRegistry[TPath]` to recover the typed `vars` contract.
//
// Before any sidecar is generated, `keyof PromptFileRegistry` is `never`. The
// `step.define` overload widens to `PromptVars` in that fallback case, so
// editing a prompt file mid-codegen does NOT red-light every consuming
// workflow before `orch types` catches up.
//
// Augmentation example (this is the shape `emit-sidecar.ts` produces in U7;
// users do NOT write this by hand):
//
// ```ts
// // .orch/prompts/brainstorm.md.d.ts — AUTO-GENERATED
// declare module 'orch' {
//   interface PromptFileRegistry {
//     '@/.orch/prompts/brainstorm.md': { topic: string; depth?: number }
//   }
// }
// export {}
// ```
//
// The `export {}` makes the sidecar a module, which is required for TS to
// honour the `declare module 'orch'` augmentation.

// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — augmented externally
export interface PromptFileRegistry {}
