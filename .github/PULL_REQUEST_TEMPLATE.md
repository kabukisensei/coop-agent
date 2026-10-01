<!-- Thanks for contributing to coop-agent. Keep it focused; coop is PowerShell (Windows PowerShell 5.1 and pwsh 7). -->

## What & why

<!-- What does this change and why? Link any issue. -->

## Checklist

- [ ] PowerShell parses: `pwsh -NoProfile -Command "Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object { $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e); if ($e) { $_.FullName; $e } }"` and `pwsh -NoProfile -File scripts/check-bom.ps1` passes (tests/run.ps1 runs it first)
- [ ] `coop doctor` still green on my machine
- [ ] `pwsh -File tests/run.ps1` and `bash tests/run.sh` pass locally (CI runs both, plus `tests/run.ps1` under Windows PowerShell 5.1)
- [ ] Governance preserved: read-only first, plan-and-approve, never commit source, MCP read-only, no secrets
- [ ] New skills are advisory/read-only and reference `coop-workflow`; no name collision with existing skills
- [ ] Updated docs (`README.md` / `docs/*`) and `CHANGELOG.md` (`## [Unreleased]`) as needed
- [ ] No secrets / tenant ids / tokens / generated artifacts committed

## Notes

<!-- Anything reviewers should know, e.g. not yet run on a Windows workstation. -->
