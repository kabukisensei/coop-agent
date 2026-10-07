#!/usr/bin/env pwsh
#
# check-bom.ps1 — PowerShell source encoding gate: the repo's one BOM check.
# Run by tests/run.ps1 (first section, every lane), by `coop release`
# (Invoke-CoopRelease in bin/coop.ps1 and scripts/release.sh) and locally before
# a PR: `pwsh -NoProfile -File scripts/check-bom.ps1`. Three rules:
#   1. every .ps1 in the repo starts with exactly ONE UTF-8 BOM (EF BB BF) —
#      Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (mojibake), and a
#      duplicate BOM makes it parse the shebang line as a command;
#   2. the launch-critical .ps1 files have a `#!` comment right after the BOM;
#   3. no .ps1 ends a line with a bash-style backslash continuation (#90).
# The one exception is scripts/bootstrap.ps1, run as `irm <url> | iex`: iex gets
# a BOM as a character and fails on line 1, so that file must be pure ASCII with
# NO BOM (ASCII reads the same in 5.1 without one).
# Windows PowerShell 5.1 and pwsh 7 both run it; no module, no bash.
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$G_CHECK = [char]0x2713; $G_CROSS = [char]0x2717; $G_ARROW = [char]0x2192
$script:fail = 0
function Ko([string]$m) { Write-Output "  $G_CROSS $m"; $script:fail = 1 }
function Ok([string]$m) { Write-Output "  $G_CHECK $m" }

# Every .ps1 under the repo, as repo-relative forward-slash paths in ordinal order
# (.git, node_modules and .cache are never source).
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.ps1' |
  ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/' } |
  Where-Object { $_ -notmatch '^(\.git|\.cache)/' -and $_ -notmatch '(^|/)node_modules/' })
$files = @([string[]]$files | Sort-Object { [string]$_ })

function Get-LeadBytes([string]$Path, [int]$Count) {
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $buf = New-Object byte[] $Count
    $n = $fs.Read($buf, 0, $Count)
    if ($n -lt $Count) { $buf = $buf[0..([Math]::Max($n, 1) - 1)]; if ($n -eq 0) { $buf = @() } }
    return [byte[]]$buf
  } finally { $fs.Dispose() }
}
function Test-Bom([byte[]]$B, [int]$At) {
  return ($B.Length -ge ($At + 3) -and $B[$At] -eq 0xEF -and $B[$At + 1] -eq 0xBB -and $B[$At + 2] -eq 0xBF)
}

Write-Output "$G_ARROW UTF-8 BOM on every .ps1 (exactly one — a duplicate BOM breaks the launcher)"
$iexOnly = 'scripts/bootstrap.ps1'
foreach ($f in $files) {
  $b = Get-LeadBytes (Join-Path $root $f) 6
  if ($f -eq $iexOnly) {
    $all = [System.IO.File]::ReadAllBytes((Join-Path $root $f))
    $nonAscii = @($all | Where-Object { $_ -gt 0x7F }).Count
    if (Test-Bom $b 0) { Ko "$f must NOT start with a UTF-8 BOM: it runs as irm | iex, where a BOM breaks line 1. Fix: strip the first three bytes" }
    elseif ($nonAscii -gt 0) { Ko "$f must be pure ASCII (no BOM allowed, so Windows PowerShell 5.1 would misread other characters): $nonAscii non-ASCII byte(s)" }
    else { Ok "$f (ASCII, no BOM: runs as irm | iex)" }
    continue
  }
  if ((Test-Bom $b 0) -and (Test-Bom $b 3)) {
    Ko "$f starts with TWO UTF-8 BOMs — the extra BOM makes PowerShell parse the shebang as a command. Fix: strip all leading BOMs, then prepend exactly one"
  } elseif (Test-Bom $b 0) {
    Ok $f
  } else {
    Ko "$f is missing the UTF-8 BOM — fix: printf '\357\273\277' | cat - '$f' > '$f.bom' && mv '$f.bom' '$f'"
  }
}

Write-Output "$G_ARROW launch-critical .ps1 first line is a comment after the BOM"
# The launcher and the knowledge sync script must have a '#!' comment line right
# after the BOM: a duplicate BOM leaves U+FEFF before '#!' and PowerShell chokes
# on it (review finding 1).
foreach ($f in @('bin/coop.ps1', 'scripts/sync-knowledge.ps1')) {
  $p = Join-Path $root $f
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Ko "$f is missing — cannot check its first line"; continue }
  $first = [System.IO.File]::ReadLines($p) | Select-Object -First 1
  $first = ([string]$first).TrimStart([char]0xFEFF).TrimEnd("`r")
  if ($first.StartsWith('#!')) { Ok "$f first line is a shebang comment after the BOM" }
  else { Ko "$f first line is not a comment (leading garbage/BOM?): $first" }
}

Write-Output "$G_ARROW no bash-style backslash line continuation in any .ps1"
# PowerShell continues a line with a backtick, never a backslash. A trailing ' \'
# passes the parsers: the backslash becomes an argument and the next line runs as
# its own statement, which is how doctor.ps1 --json printed hints before its JSON
# (#90). Comments and here-string bodies (embedded sh scripts) are exempt.
$bsBad = $false
foreach ($f in $files) {
  $hits = @()
  $here = $false
  $n = 0
  foreach ($raw in [System.IO.File]::ReadLines((Join-Path $root $f))) {
    $n++
    $line = ([string]$raw).TrimEnd()
    $lead = $line.TrimStart()
    if ($here) {
      if ($lead.StartsWith('"@') -or $lead.StartsWith("'@")) { $here = $false }
      continue
    }
    if ($lead.StartsWith('#')) { continue }
    if ($line.EndsWith('@"') -or $line.EndsWith("@'")) { $here = $true; continue }
    if ($line -match '\s\\$') { $hits += $n }
  }
  if ($hits.Count -gt 0) {
    Ko "$f ends a line with a bash-style \ continuation (line $($hits -join ' ')) — join the call onto one line or build the argument in a variable first"
    $bsBad = $true
  }
}
if (-not $bsBad) { Ok 'no .ps1 ends a line with a bash-style backslash continuation' }

if ($script:fail -ne 0) {
  Write-Output "$G_CROSS BOM check FAILED — fix the offenders above (see CONTRIBUTING.md → PowerShell requirements)"
  exit 1
}
Write-Output "$G_CHECK BOM check passed"
