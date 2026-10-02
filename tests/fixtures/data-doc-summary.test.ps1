#!/usr/bin/env pwsh
# `coop data-doc` summary (bin/coop.ps1 Invoke-DataDoc + Get-CoopDataDocGraphPath)
# against a stub coop-data-doc (one Python script, tests/fixtures/_common.ps1
# New-PyStub). The stub's `show-config` mirrors the companion's discovery (an
# explicit --config, then the nearest coop-data-doc.yml in this folder or a
# parent) and prints the config's path and output.dir as JSON. Checks: a build
# from a subfolder summarizes the graph under the PARENT config's custom output
# dir (never a decoy manifest.json in the cwd); a failed build propagates its
# exit code with no summary; `check` gets no summary and never calls
# show-config; `--config` reaches show-config; a graph with non-ASCII names
# (UTF-8 bytes the Windows ANSI code page cannot decode) still summarizes. Sandboxed HOME/USERPROFILE/
# COOP_DIR/agent dir, never ~/.coop. No waits. Assertions stay ASCII and ignore
# whitespace (Windows PowerShell 5.1 re-encodes child output).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$coop = Join-Path (Join-Path $root 'bin') 'coop.ps1'
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-ddsummary-ps-' + [guid]::NewGuid().ToString('N'))
$bin = Join-Path $t 'bin'
$estate = Join-Path $t 'estate'
$sub = Join-Path $estate 'models\sales'
$alt = Join-Path $t 'alt'
$argsLog = Join-Path $t 'dd-args.log'
$saved = Save-Env @('PATH','HOME','USERPROFILE','COOP_DIR','COOP_AGENT_DIR','PI_CODING_AGENT_DIR','COOP_SKIP_AZ',
                    'NO_COLOR','COOP_DATA_DOC_CONFIG','DD_ARGS_LOG','DD_BUILD_RC')
try {
  New-Item -ItemType Directory -Force -Path $bin, $sub, (Join-Path $estate 'out\lineage'), (Join-Path $alt 'docs-out'),
    (Join-Path $t 'coop\.coop') | Out-Null
  $sandboxHome = New-SandboxHome (Join-Path $t 'home')
  [System.IO.File]::WriteAllText((Join-Path $estate 'coop-data-doc.yml'),
    "project_name: x`noutput:`n  dir: ./out/lineage`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $estate 'out\lineage\graph.json'),
    ('{"coverage": {}, "nodes": {"a": {}, "b": {}, "' + [char]0x0141 + 'odz": {}}, "edges": [{}, {}]}'), $utf8)
  # A decoy the old fixed-location scan picked up from the cwd.
  [System.IO.File]::WriteAllText((Join-Path $sub 'manifest.json'), '{"nodes": {"z": {}}, "edges": []}', $utf8)
  [System.IO.File]::WriteAllText((Join-Path $alt 'alt.yml'), "output:`n  dir: docs-out`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $alt 'docs-out\graph.json'), '{"nodes": {"q": {}}, "edges": [{}, {}, {}, {}]}', $utf8)

  New-PyStub $bin 'coop-data-doc' @'
import json, os, re, sys
args = sys.argv[1:]
with open(os.environ["DD_ARGS_LOG"], "a", encoding="utf-8") as log:
    log.write(" ".join(args) + "\n")
cmd = args[0] if args else ""
if cmd == "show-config":
    cfg = None
    for i, a in enumerate(args):
        if a == "--config" and i + 1 < len(args):
            cfg = os.path.abspath(args[i + 1])
        elif a.startswith("--config="):
            cfg = os.path.abspath(a.split("=", 1)[1])
    if cfg is None:
        d = os.getcwd()
        while True:
            if os.path.isfile(os.path.join(d, "coop-data-doc.yml")):
                cfg = os.path.join(d, "coop-data-doc.yml")
                break
            if os.path.dirname(d) == d:
                break
            d = os.path.dirname(d)
    if cfg is None or not os.path.isfile(cfg):
        print(json.dumps({"exists": False, "path": "coop-data-doc.yml", "output": {"dir": "./data-docs"}}))
        sys.exit(0)
    m = re.search(r"^\s+dir:\s*(\S+)", open(cfg, encoding="utf-8").read(), re.M)
    print(json.dumps({"exists": True, "path": cfg, "output": {"dir": m.group(1) if m else "./data-docs"}}, indent=2))
    sys.exit(0)
if cmd in ("build", "update", "scan"):
    print("stub " + cmd)
    sys.exit(int(os.environ.get("DD_BUILD_RC", "0")))
print("stub " + cmd)
'@ | Out-Null
  # An npm stub keeps Add-CoopRuntimePaths from putting a real npm prefix (and a
  # real coop-data-doc) first on PATH.
  Write-Shim 'npm' 'if [ "$1" = "--version" ]; then echo 10.0.0; fi; exit 0' 'if "%1"=="--version" echo 10.0.0& exit /b 0'

  $env:PATH = "$bin$sep$($env:PATH)"
  $env:HOME = $sandboxHome
  $env:USERPROFILE = $sandboxHome
  $env:COOP_DIR = Join-Path $t 'coop'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  $env:DD_ARGS_LOG = $argsLog
  Remove-Item -LiteralPath 'Env:\COOP_DATA_DOC_CONFIG' -ErrorAction SilentlyContinue

  # Invoke-DataDoc <cwd> <args...>: run `coop data-doc <args>` from <cwd>.
  function Invoke-DataDoc([string]$Cwd, [string[]]$DdArgs = @()) {
    Remove-Item -LiteralPath $argsLog -Force -ErrorAction SilentlyContinue
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $Cwd
    try {
      $lines = @(& $psExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $coop data-doc @DdArgs 2>&1 | ForEach-Object { [string]$_ })
      $rc = $LASTEXITCODE
    } finally { Pop-Location; $ErrorActionPreference = $eap }
    $raw = $lines -join "`n"
    $log = if (Test-Path -LiteralPath $argsLog) { [System.IO.File]::ReadAllText($argsLog) } else { '' }
    return @{ Out = $raw; Flat = ($raw -replace '\s', ''); Rc = $rc; Log = $log }
  }
  $flat = { param([string]$s) $s -replace '\s', '' }

  # 1. Bare `coop data-doc` (build) from a subfolder summarizes the parent config's graph.
  $r = Invoke-DataDoc $sub
  $graph = (Resolve-Path -LiteralPath (Join-Path $estate 'out\lineage\graph.json')).ProviderPath
  if ($r.Rc -ne 0) { Ko "coop data-doc from a subfolder should exit 0 (got $($r.Rc))" $r.Out }
  elseif ($r.Flat.Contains((& $flat "Machine-readable output: $graph")) -and $r.Flat.Contains('3nodes,2edges')) {
    Ok "a build from a subfolder summarizes the parent config's graph (custom output dir)"
  } else { Ko 'the summary should name the parent config''s graph.json with 3 nodes, 2 edges' $r.Out }
  if ($r.Flat.Contains('1nodes')) { Ko 'the decoy manifest.json in the cwd must not be summarized' $r.Out }
  else { Ok 'a manifest.json in the cwd that the build did not write is ignored' }

  # 2. A failed build keeps its exit code and prints no summary.
  $env:DD_BUILD_RC = '3'
  $r = Invoke-DataDoc $estate @('build')
  Remove-Item -LiteralPath 'Env:\DD_BUILD_RC' -ErrorAction SilentlyContinue
  if ($r.Rc -eq 3 -and -not $r.Flat.Contains('Machine-readableoutput') -and -not $r.Log.Contains('show-config')) {
    Ok 'a failed build propagates its exit code with no summary'
  } else { Ko "a failed build should exit 3 with no summary (rc=$($r.Rc))" ($r.Out + "`n" + $r.Log) }

  # 3. Subcommands that write no graph get no summary.
  $r = Invoke-DataDoc $estate @('check')
  if ($r.Rc -eq 0 -and -not $r.Flat.Contains('Machine-readableoutput') -and -not $r.Log.Contains('show-config')) {
    Ok 'check gets no summary and never calls show-config'
  } else { Ko "check should print no summary (rc=$($r.Rc))" ($r.Out + "`n" + $r.Log) }

  # 4. --config reaches show-config, so the summary follows the named config.
  $altCfg = Join-Path $alt 'alt.yml'
  $r = Invoke-DataDoc $sub @('scan', '--config', $altCfg)
  $altGraph = (Resolve-Path -LiteralPath (Join-Path $alt 'docs-out\graph.json')).ProviderPath
  if ($r.Rc -eq 0 -and $r.Flat.Contains((& $flat "Machine-readable output: $altGraph")) -and $r.Flat.Contains('1nodes,4edges')) {
    Ok 'scan --config <file> summarizes that config''s graph'
  } else { Ko 'scan --config should summarize the named config''s graph (1 nodes, 4 edges)' ($r.Out + "`n" + $r.Log) }
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -ne 0) { exit 1 }
