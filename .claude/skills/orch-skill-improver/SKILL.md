---
name: orch-skill-improver
description: >-
  Run a retrospective on a skill you just finished using, and turn what the run
  revealed into concrete improvements to that skill. Use this at the end of a
  run whenever a skill helped or got in the way and the user wants to make it
  better next time — e.g. "improve the skill we just used", "that skill should
  have warned me about X, fix it", "the phase-implementer steps were confusing,
  let's tighten them", "retro on orch-rebase", "/orch-skill-improver". Triggers
  even when the user only gestures at it ("that could've gone smoother, can we
  fix the skill?"). It analyzes the run for friction, grounds every suggestion
  in something that actually happened, presents them for selection, and applies
  the chosen ones via a sub-agent that returns a diff. Do NOT use this to author
  a brand-new skill (that's write-a-skill) or to improve the codebase itself
  (that's improve-codebase-architecture) — this improves an existing skill in
  .claude/skills/ based on a run that exercised it.
---

# orch-skill-improver — turn a run into a better skill

A skill is meant to be used a thousand times. This run is one of those thousand.
Your job here is to look back at the run that just happened, notice where the
skill helped and where it fought you, and propose changes that will make the
*next thousand* runs go better — then, on the user's say-so, apply the ones they
pick.

It exists because the best signal for improving a skill is a real run of it,
while the friction is still fresh in context. But that context is also expensive:
by the time you reach this point you've usually burned a lot of tokens. So this
skill splits the work — **the analysis happens here** (it needs the run in
context), and **the editing is handed to a fresh sub-agent** with a self-contained
brief, so the careful file-rewriting doesn't pile onto an already-heavy window.

## The one idea that shapes everything: generalize, don't overfit

A single run is one data point. The trap is reacting to one bad moment by bolting
a rigid `MUST` or a fiddly special-case onto the skill — which makes it worse for
the 999 runs that didn't hit that moment. So hold every candidate improvement to
this bar:

- **Grounded** — tied to a specific thing that happened in *this* run, not a
  generic best-practice you'd suggest for any skill.
- **Concrete** — names the file and section and the actual change (reword this
  line, add this script, drop this step), not "make step 3 clearer".
- **Generalizable** — would help across many future runs, not just this exact
  task. This is the filter that matters most.

When a step fought you, the fix is often to *remove* it, not to caveat it. When
an instruction was misread, prefer reframing it and explaining the *why* over
adding a louder rule. And it's a completely valid outcome to conclude "the skill
held up — nothing worth changing." Say that honestly rather than inventing work.

## The flow

### 1. Pin down which skill you're improving

Almost always it's the skill the run just exercised. Name it explicitly and
confirm with the user, along with its path under `.claude/skills/<name>/`. If the
run touched more than one skill, ask which one (handle one at a time). If no skill
was actually used this run, there's nothing to learn from — say so, and point the
user at `write-a-skill` if they want to author one instead.

### 2. Mine the run for evidence

This is where the value is. Re-read the run looking for every moment the skill
shaped what happened — good and bad. Signals worth capturing:

- **Wrong turns from unclear instructions** — places you misread a step, did the
  wrong thing and backtracked, or asked the user something the skill could have
  answered. Each is a candidate "this instruction is ambiguous."
- **Errors that trace to the skill** — a failure caused by the skill telling you
  to do something that didn't work, or not warning you about a trap. (Distinguish
  these from errors that were just the task being genuinely hard — those aren't
  the skill's fault and aren't your business here.)
- **Reinvented work** — a script, command, or snippet you wrote from scratch that
  the skill could have bundled. Litmus test: *would you write essentially the same
  thing again on the next run?* If yes, it wants to be a bundled script.
- **Wasted motion** — steps the skill made you do that turned out redundant,
  unproductive, or over-constrictive; places the skill got in your way.
- **Missing context** — facts you had to go discover (file locations, conventions,
  gotchas) that the skill should simply have stated up front.
- **What worked** — instructions that clearly helped. Note these too, so a later
  edit doesn't accidentally regress them.

For each candidate, write down the concrete moment — what actually happened, in a
sentence or two. That evidence is what makes a suggestion credible, and it's
exactly what you'll hand the sub-agent (which can't see this run).

### 3. Read the current skill

Read the target's `SKILL.md` and any `references/`/`scripts/` your candidates
would touch. You can't propose "reword this line" without knowing what the line
says today, and you can't suggest a new script without knowing one doesn't already
exist. Every suggestion must land against real, current text.

### 4. Turn evidence into ranked suggestions

Run each candidate through the bar above (grounded / concrete / generalizable) and
the anti-overfit pass. Drop the ones that only help this exact prompt. For the
survivors, write each as:

- **Problem** — what went wrong (or could be better), with the run evidence.
- **Change** — the specific edit: file, section, and what to do.
- **Benefit** — what improves across future runs.

Rank by impact. A tight list of two strong, generalizable changes beats ten
overfit nitpicks.

### 5. Present — apply nothing yet

Show the ranked suggestions and let the user choose which to apply. Use a
selection prompt (`AskUserQuestion` with `multiSelect`) or a numbered list they
can pick from. Nothing gets written until they choose. The scope is fixed: only
skills under this repo's `.claude/skills/`.

### 6. Hand the chosen edits to a sub-agent

You're at the end of a long run. The analysis needed all that context; the editing
does not — it needs a clear brief and a fresh window. Spawn a sub-agent (the
`Agent` tool) and give it everything, so it never has to rediscover what you
already worked out. Because it cannot see this run, the brief must be
self-contained. Use this structure:

```
You are improving an existing orch skill. Edit ONLY files under its directory.

Target skill: <name>
Path: /Users/.../.claude/skills/<name>/

Apply these approved changes (and only these):

1. <suggestion title>
   - Problem: <what went wrong>
   - Evidence (from the run): <the concrete moment — quote/paraphrase>
   - Change: <file + section + exactly what to do>
   - Benefit: <why it helps future runs>
2. ...

Conventions to follow:
- Read .claude/skills/write-a-skill/SKILL.md for structure rules.
- Match the orch house style: narrative prose that explains the *why*, prefer
  bundled scripts over ad-hoc commands, files <=300 lines, progressive disclosure
  (push depth into references/ rather than bloating SKILL.md).
- Look at sibling skills (orch-rebase, orch-workflow-author) as style examples.

Hard constraints:
- Edit only files inside the target skill's directory.
- Do NOT commit. Leave a clean, reviewable working tree.
- Keep changes minimal and faithful to the approved suggestions — do not
  rewrite things that already work, and do not add improvements nobody approved.
- Preserve the instructions this run showed were working.

Deliverable: a short summary of what you changed and why, followed by the output
of `git diff -- .claude/skills/<name>/`.
```

Run it in the foreground — it's the last step, and you want its diff back to relay.

### 7. Relay the diff

Surface the sub-agent's summary and `git diff` to the user. Remind them nothing is
committed — they review and commit when they're happy. If a change overshot or
missed the mark, offer to send the sub-agent a correction rather than editing
inline (keeps the heavy context off this window).

## Guardrails

- **Scope:** only skills under this repo's `.claude/skills/`. Never edit global or
  plugin skills.
- **Never auto-apply.** Selection gates every change; an empty selection means you
  do nothing.
- **Never commit.** Leave a diff for the user to review.
- **Don't regress what worked.** Improvements that break a working instruction are
  a net loss.
- **Don't overfit.** If a finding only helps this one prompt, drop it.
- **Authoring ≠ improving.** A brand-new skill is `write-a-skill`'s job; codebase
  changes are `improve-codebase-architecture`'s. This skill improves an existing
  skill from a run that used it.
