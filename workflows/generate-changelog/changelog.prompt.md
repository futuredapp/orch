You are updating the `CHANGELOG.md` of the **orch** repository for an upcoming
release. Work autonomously: run your own `git` commands to read history, then
edit `CHANGELOG.md` in place. Do **not** create a git commit — leave the edited
file in the working tree for the maintainer to review.

## Requested scope

{{request}}

If the requested scope above is empty or does not name a version/range, derive
the range yourself: run `git tag --list 'v*' --sort=-v:refname` to find the most
recent version tag, then `git log <lastTag>..HEAD` to read every commit since
it. If there is no prior `v*` tag, read the full history. Infer the new version
number from the requested scope when given; otherwise propose the next semver
patch/minor above the last tag and state your assumption at the top of your
final message.

## How to read the commits

Use bash directly, for example:

```
git tag --list 'v*' --sort=-v:refname | head -1
git log --no-merges --pretty=format:'%s' <range>
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
Group them by type:

- `feat:` → **### Features**
- `fix:` → **### Fixes**
- everything else (`chore:`, `docs:`, `refactor:`, `build:`, `ci:`, `test:`,
  `perf:`, `style:`) → **### Chores**

Drop pure noise (merge commits, version-bump-only commits). Rewrite each entry
as a short, user-facing line — not the raw commit subject.

## Output format

Prepend a new entry to `CHANGELOG.md` directly under the format header and above
the most recent existing entry. Match the existing structure exactly:

```
## [<version>] - <YYYY-MM-DD>

<One short prose paragraph summarising the most notable changes — the headline
features a reader should know about, in plain language.>

### Features

- ...

### Fixes

- ...

### Chores

- ...
```

Rules:

- The entry **must open with the prose summary paragraph** before any `###`
  grouping.
- Use today's date (`date +%Y-%m-%d`) for the `<YYYY-MM-DD>` field.
- Omit any `###` group that has no entries.
- Add the matching link reference at the bottom of the file
  (`[<version>]: https://github.com/futuredapp/orch/releases/tag/v<version>`).
- Preserve every existing entry below the new one untouched.

When done, print a short summary of what you wrote and remind the maintainer to
review and finalise the prose before tagging. Do not run `git add` or
`git commit`.
