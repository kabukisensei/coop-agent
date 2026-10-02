#!/usr/bin/env pwsh
# Install/update busy guard (issue #234): Test-CoopPiRunning may count only the
# coop/pi sessions run from THIS install's npm tree (Get-CoopNpmGlobalRoots), so a
# second, isolated install (a redirected profile on E:) converges Pi in place and
# exits 0 while coop is open from the daily C: install. A session from the same
# install still trips the guard. In-process, offline, no real process is
# inspected: the rows are fake Win32_Process shapes (ProcessId, CommandLine)
# passed through the function's parameters.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $root 'lib\common.ps1')

function Row([int]$ProcId, [string]$CommandLine) {
  return (New-Object PSObject -Property @{ ProcessId = $ProcId; CommandLine = $CommandLine })
}
function Expect([string]$Label, [bool]$Got, [bool]$Want) {
  if ($Got -eq $Want) { Ok $Label } else { Ko "$Label (got $Got, want $Want)" }
}

# The daily install (C:) and the isolated sandbox install (E:, APPDATA redirected).
$cRoot = 'C:\Users\aaron\AppData\Roaming\npm\node_modules'
$eRoot = 'E:\coop-sandbox\AppData\Roaming\npm\node_modules'
$cPi = '"C:\Program Files\nodejs\node.exe"  "C:\Users\aaron\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js" -e C:\dev\coop-agent\extensions\coop-powerline'
$ePi = '"C:\Program Files\nodejs\node.exe"  "E:\coop-sandbox\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js"'
$cOtherTool = '"C:\Program Files\nodejs\node.exe"  "C:\Users\aaron\AppData\Roaming\npm\node_modules\some-other-tool\bin\cli.js"'

# --- one command line against the roots -------------------------------------
Expect 'same install: C: session counts against the C: root'        (Test-CoopPiCommandLineOwned $cPi @($cRoot)) $true
Expect 'other install: C: session does not count against the E: root' (Test-CoopPiCommandLineOwned $cPi @($eRoot)) $false
Expect 'same install: E: session counts against the E: root'        (Test-CoopPiCommandLineOwned $ePi @($eRoot)) $true
Expect 'several roots: a session under any of them counts'          (Test-CoopPiCommandLineOwned $cPi @($eRoot, $cRoot)) $true
Expect 'a non-Pi node tool under the root never counts'             (Test-CoopPiCommandLineOwned $cOtherTool @($cRoot)) $false
Expect 'an empty command line never counts'                         (Test-CoopPiCommandLineOwned '' @($cRoot)) $false
Expect 'no root known: every pi-coding-agent session counts (as before)' (Test-CoopPiCommandLineOwned $cPi @()) $true
Expect 'no root known (blank entries only): every session counts'   (Test-CoopPiCommandLineOwned $cPi @('', $null)) $true
# Matching is a path match, not a string prefix: case, separators and a sibling
# dir whose name merely starts with the root.
Expect 'root with forward slashes and other case still matches'     (Test-CoopPiCommandLineOwned $cPi @('c:/users/aaron/appdata/roaming/npm/node_modules/')) $true
Expect 'a sibling dir that only starts with the root text does not match' (Test-CoopPiCommandLineOwned $cPi @('C:\Users\aaron\AppData\Roaming\npm\node_mod')) $false

# --- the row walk (fake Win32_Process rows) -----------------------------------
$meRow = Row $PID $ePi      # this process never counts, whatever its command line
$cRow = Row 4242 $cPi
$eRow = Row 5151 $ePi
$toolRow = Row 6161 $cOtherTool
Expect 'rows: C: session open, installing into E: -> not busy'      (Test-CoopPiRunning @($meRow, $cRow, $toolRow) @($eRoot)) $false
Expect 'rows: E: session open, installing into E: -> busy'          (Test-CoopPiRunning @($meRow, $cRow, $eRow) @($eRoot)) $true
Expect 'rows: C: session open, installing into C: -> busy'          (Test-CoopPiRunning @($cRow) @($cRoot)) $true
Expect 'rows: only this process and a non-Pi tool -> not busy'      (Test-CoopPiRunning @($meRow, $toolRow) @($eRoot)) $false
Expect 'rows: no node processes at all -> not busy'                 (Test-CoopPiRunning @() @($eRoot)) $false
Expect 'rows: no root known -> any Pi session is busy (as before)'  (Test-CoopPiRunning @($cRow) @()) $true

exit $fail
