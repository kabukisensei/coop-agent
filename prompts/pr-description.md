# /pr-description

Use the `git-helper` skill.

Draft a PR description for the current working tree: run `git status` and
`git diff` (read-only), then output **Summary**, **Changes**, **Lineage impact**,
**Standards & validation**, and **Rollback** sections. If the user asked for a
commit message instead, draft it in Conventional Commits style.

Draft only — do not commit, push, or merge; a human owns the commit and the PR.
