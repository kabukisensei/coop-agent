#requires -Version 5.1
# Report a bug or send an idea or question to the coop team, from a shell (the
# form of /feedback for when coop itself will not start). Builds a redacted
# report, shows it for editing, then opens a pre-filled issue on the private
# coop feedback repository in the browser; nothing is sent by coop.
# Usage: coop feedback [--kind bug|idea|question] [--title TEXT] [--print] [--no-open]
$ErrorActionPreference = 'Stop'

$COOP_ROOT = Split-Path -Parent $PSScriptRoot
$env:COOP_ROOT = $COOP_ROOT

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('coop feedback needs Node.js (node was not found on PATH). Run: coop install')
  exit 1
}
& node (Join-Path $COOP_ROOT 'lib\feedback-cli.mjs') @args
exit $LASTEXITCODE
