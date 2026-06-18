<!-- Thanks for contributing to coop-agent. Keep it focused and cross-platform. -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Checklist

- [ ] Shell syntax passes: `for f in bin/coop lib/common.sh scripts/*.sh; do bash -n "$f"; done`
- [ ] `coop doctor` still green on my machine
- [ ] If I changed `bin/coop` or a `scripts/*.sh`, I mirrored it in `bin/coop.ps1` / `scripts/*.ps1`
- [ ] Governance preserved: read-only first, plan-and-approve, never commit source, MCP read-only, no secrets
- [ ] New skills are advisory/read-only and reference `coop-workflow`; no name collision with existing skills
- [ ] Updated docs (`README.md` / `docs/*`) and `CHANGELOG.md` (`## [Unreleased]`) as needed
- [ ] No secrets / tenant ids / tokens / generated artifacts committed

## Notes

<!-- Anything reviewers should know, e.g. Windows path not yet runtime-tested. -->
