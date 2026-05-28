# Worktrees and commits

> **What you'll learn:** how to isolate a workflow in its own git worktree and create commits as first-class steps.

A workflow that edits code should usually do it somewhere safe — a dedicated branch in its own working directory — and commit as it goes. orch makes both first-class, memoizable steps so they show up in status and survive resume. Runnable reference: the [`worktree-demo` example](/examples).

## Isolate the run in a worktree

`createWorktree(branch, opts)` materializes a git worktree on a fresh branch. With `enter: true`, the workflow's cwd switches into it, so every subsequent `run()` and `commit()` operates inside the worktree:

```ts
// .orch/workflows/isolated-feature.ts
import { workflow, step, createWorktree, commit, claude } from 'orch'

const IMPLEMENT = step.define('implement', {
  agent: claude(),
  prompt: 'Implement the requested feature.',
})

export default workflow('isolated-feature', async (run) => {
  await run(createWorktree('feat/new-thing', { enter: true }))

  await run(IMPLEMENT)              // runs inside the worktree
  await run(commit('feat: new thing')) // commits inside the worktree
})
```

`enter` is required so the choice is explicit. By default the worktree is created as a sibling directory off `HEAD`; override the base ref with `from:` and the location with `target:` (see the [`createWorktree` reference](/reference/api#createworktree)).

## Set up the worktree with postCreate

A fresh worktree often needs its own untracked files or dependencies. `postCreate` runs right after the worktree is materialized. The sugar form is a list of shell lines, each run via `/bin/sh -c` with `$ORIGIN` (the original checkout) and `$TARGET` (the new worktree) in the environment:

```ts
await run(createWorktree('feat/new-thing', {
  enter: true,
  postCreate: ['cp $ORIGIN/.env .', 'bun install'],
}))
```

For anything beyond a few lines, pass a callback instead of strings — it receives a context with the paths. The reference lists both forms.

## Commit as a step

`commit(message)` stages everything (`git add .`) and creates a commit. It returns `{ sha }`, or `null` when the working tree was already clean:

```ts
const result = await run(commit('feat: new thing'))
if (result === null) {
  // nothing to commit — common on resume after the commit already landed
}
```

The `null` case is normal on resume: the commit ran the first time, so the second pass finds a clean tree. Handle it rather than asserting a sha.

::: warning `git add .` stages everything
A commit step stages every change in the tree, including anything an agent wrote that you didn't intend — `.env`, `*.pem`, build output. Review what your steps produce, and lean on a `.gitignore` in the worktree.
:::

## Worktrees with parallel work

To give each [parallel](/guides/parallel-work) branch its own checkout, use the **homogeneous** form of `parallel()` — a worktree per item:

```ts
import { parallel } from 'orch'

await parallel(['auth', 'api'], async (module) => {
  await run(createWorktree(`feat/${module}`, { enter: true, target: `../wt-${module}` }))
  await run(IMPLEMENT, { as: `impl-${module}`, prompt: `Implement ${module}` })
  await run(commit(`feat(${module}): done`), { as: `commit-${module}` })
})
```

Each branch enters its *own* worktree, so the concurrent `enter` calls don't fight over one cwd. `enter: true` is **not** valid in the heterogeneous (array) form of `parallel()`, where branches share a single cwd.

## Where to go next

- [Parallel work](/guides/parallel-work) — the fan-out this composes with.
- [Validators](/guides/validators) — `gitCommitCreated()` to assert a commit actually landed.
- [`createWorktree`](/reference/api#createworktree) and [`commit`](/reference/api#commit) references.
