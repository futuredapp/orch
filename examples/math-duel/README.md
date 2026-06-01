# math-duel

Fan out two runners on the same task, then judge them with plain code.

```
pose      Claude, autonomous   → { problem, answer }     invent a problem + ground truth
solve     Claude ‖ Codex       → { answer, reasoning }   both solve it in parallel (typed)
compare   no agent, pure TS    → duel-results.md         deterministic scoring
check     Claude, autonomous   → { same, note }          re-reads the file, judges agreement
```

The teaching point: the agent stages use **structured output**
(`returns: schema(...)`), so they hand back typed values. The `compare` stage is
**not** an agent — it's ordinary TypeScript that scores those values against the
ground truth and writes a markdown scorecard. Then `check` is an agent again: it
re-reads the scorecard and independently judges whether the two runners agreed,
and the workflow flags any disagreement with the deterministic result. Agents
produce data; your code decides what it means; an agent sanity-checks your code.

`parallel([...])` runs the two solvers concurrently because they're genuinely
independent — neither solver depends on the other's answer.

## Run

```bash
bunx orch run math-duel                              # Claude invents the problem
bunx orch run math-duel "two-step percentage word problem"   # steer the problem
```

Requires `claude` and `codex` (>= 0.118.0) on PATH. Writes `duel-results.md` to
the working directory.
