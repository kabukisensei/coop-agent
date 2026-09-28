# Shared Windows review implementation. Stable sources it lazily; the beta
# lifecycle executes it under the existing owned process and operation lease.
function Invoke-CoopReviewTool {
  param([string]$Name, [string[]]$Vector)
  if (-not $script:CoopInstallationContext) { & $Name @Vector; return }
  $selected = $script:CoopReviewVectors.PSObject.Properties[$Name].Value
  if (-not $selected) { throw 'Selected beta reviewer is unavailable' }
  Invoke-CoopOwnedProcess -FilePath $selected.executable -ArgumentVector (@($selected.args) + $Vector) -TimeoutMilliseconds 240000 -ReadOnly
}

# --- coop review: both linters + compose findings onto the lineage docs -------
# Mirror of run_review in bin/coop. One command for the whole advisory loop: run
# coop-sql-review AND coop-dax-review over the same scope (each tool filters by
# file type itself), save both JSON reports under .coop/reviews/ next to the
# contract, then rebuild the lineage docs with the findings composed in
# (coop-data-doc build --reviews …). Scope: explicit paths win; with none, the
# nearest .coop/project.yml's repositories.*.local_path entries — the same
# contract scoping the native sql_review/dax_review tools use (TODO placeholders
# and paths missing on this machine are skipped with a note). NEVER blind-scans
# the cwd. Advisory: linter findings don't fail the run unless --strict; docs-
# not-set-up is a hint, not a failure; a hard data-doc failure (exit 2) propagates.
function Invoke-CoopReview {
  param([string[]] $RestArgs = @())
  $strict = $false; $skipDocs = $false; $compare = $false; $doHtml = $false; $scope = @()
  $diffMode = $false; $diffRef = 'HEAD'; $needDiffRef = $false
  foreach ($a in $RestArgs) {
    if ($needDiffRef) {
      if ($a -notlike '-*') { $diffRef = $a; $needDiffRef = $false; continue }
      $needDiffRef = $false
    }
    switch -Regex ($a) {
      '^--strict$'    { $strict = $true }
      '^--skip-docs$' { $skipDocs = $true }
      '^--compare$'   { $compare = $true }
      '^--html$'      { $doHtml = $true }
      '^--diff$'      { $diffMode = $true; $needDiffRef = $true }
      '^--diff=(.*)'  { $diffMode = $true; $diffRef = $Matches[1] }
      '^(-h|--help)$' {
        Coop-Say 'Usage: coop review [paths...] [--strict] [--skip-docs] [--compare] [--html]'
        Coop-Say '  Run coop-sql-review AND coop-dax-review over the project scope (explicit paths'
        Coop-Say "  win; else the nearest .coop/project.yml's repositories.*.local_path entries),"
        Coop-Say '  save both JSON reports under .coop/reviews/, then rebuild the lineage docs with'
        Coop-Say '  the findings composed in (coop-data-doc build --reviews …).'
        Coop-Say '  --strict      pass --strict to both linters; exit 2 if either exits non-zero'
        Coop-Say '  --skip-docs   skip the coop-data-doc build step (linters only)'
        Coop-Say '  --compare     diff each linter against the previous run''s saved report and print'
        Coop-Say '                a new/fixed/persisting delta (first run just becomes the baseline)'
        Coop-Say '  --html        write a combined HTML suite report to .coop/reviews/suite.html'
        Coop-Say '  --diff [ref]  review only the files changed since [ref] (default: HEAD)'
        Coop-Say '                in git-tracked roots, falling back to full review for others'
        return
      }
      default {
        if ($a -like '-*') { Coop-Die "unknown flag '$a' — usage: coop review [paths...] [--strict] [--skip-docs] [--compare] [--diff [ref]] [--html]" }
        $scope += $a
      }
    }
  }

  if (-not (Test-Have 'coop-sql-review')) { Coop-Die 'coop-sql-review is not installed. Run: coop install' }
  if (-not (Test-Have 'coop-dax-review')) { Coop-Die 'coop-dax-review is not installed. Run: coop install' }
  if (-not $skipDocs -and -not (Test-Have 'coop-data-doc')) { Coop-Die 'coop-data-doc is not installed. Run: coop install   (or skip the docs step: coop review --skip-docs)' }

  # Scope + output dir from the project contract (same semantics as coop-tools'
  # contractReviewScope: resolve against the contract's repo root, existing only).
  $proj = Find-CoopProjectYml
  $outdir = if ($proj) { Join-Path (Split-Path -Parent $proj) 'reviews' } else { Join-Path '.coop' 'reviews' }
  if ($scope.Count -eq 0 -and $proj) {
    $base = Split-Path -Parent (Split-Path -Parent $proj)
    foreach ($p in (Get-CoopYamlList $proj 'repositories.*.local_path')) {
      if (-not $p) { continue }
      if ($p -like 'TODO*') { Coop-Warn 'skipping a repositories.local_path that is still a TODO placeholder'; continue }
      $abs = if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $base $p }
      if (Test-Path -LiteralPath $abs) { $scope += $abs } else { Coop-Warn "skipping $p (not found on this machine)" }
    }
  }
  if ($scope.Count -eq 0) { Coop-Die 'nothing to review — run inside a project with .coop/project.yml (repositories.*.local_path filled), or pass paths: coop review <paths...>' }

  if ($script:CoopInstallationContext) {
    if ($proj -and (Get-CoopYamlValue $proj 'tools.tabular_editor_cli.enabled' 'false') -eq 'true') {
      Coop-Die 'Beta Tabular Editor invocation requires executable and state qualification.'
    }
    $scope = @($scope | ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { [IO.Path]::GetFullPath($_) } else { [IO.Path]::GetFullPath((Join-Path $PWD.Path $_)) } })
    & $script:CoopInstallationContext.tools.node.path (Join-Path $script:CoopRoot 'lib/beta-lifecycle.mjs') review-scope $env:COOP_BETA_ROOT $outdir @scope
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $env:COOP_BETA_REVIEW_SUITE = if ([IO.Path]::IsPathRooted($outdir)) { [IO.Path]::GetFullPath($outdir) } else { [IO.Path]::GetFullPath((Join-Path $PWD.Path $outdir)) }
  }

  if ($diffMode) {
    $newScope = @()
    if ($script:CoopInstallationContext) {
      $selection = & $script:CoopInstallationContext.tools.node.path (Join-Path $script:CoopRoot 'lib/beta-lifecycle.mjs') review-diff $env:COOP_BETA_ROOT $outdir $diffRef @scope
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      $selection = $selection | ConvertFrom-Json
      $newScope = @($selection.paths)
      foreach ($root in $selection.untrackedRoots) { Coop-Warn "$root is not a git repository; falling back to full review for this root" }
    } else {
    foreach ($item in $scope) {
      if (Test-Path -LiteralPath $item -PathType Container) {
        $isGit = $false
        try {
          $isGit = (& git -C $item rev-parse --is-inside-work-tree 2>$null) -eq 'true'
        } catch {}
        if ($isGit) {
          $files = $(& git -C $item diff --name-only -z $diffRef --; & git -C $item ls-files -z --others --exclude-standard) -join '' -split "`0" | Where-Object { $_ }
          foreach ($f in $files) {
            $fPath = Join-Path $item $f
            if (Test-Path -LiteralPath $fPath) { $newScope += $fPath }
          }
        } else {
          Coop-Warn "$item is not a git repository; falling back to full review for this root"
          $newScope += $item
        }
      } elseif (Test-Path -LiteralPath $item -PathType Leaf) {
        $newScope += $item
      }
    }
    }
    $scope = $newScope
    if ($scope.Count -eq 0) {
      Coop-Info "coop review --diff: no files changed in the scope."
      return
    }
  }

  if ($script:CoopInstallationContext) {
    & $script:CoopInstallationContext.tools.node.path (Join-Path $script:CoopRoot 'lib/beta-lifecycle.mjs') review-backup $env:COOP_BETA_ROOT $outdir @scope
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  New-Item -ItemType Directory -Force -Path $outdir -ErrorAction SilentlyContinue | Out-Null
  if (-not (Test-Path -LiteralPath $outdir -PathType Container)) { Coop-Die "cannot create $outdir" }
  $sqlJson = ''; $daxJson = ''
  $bpaJson = Join-Path $outdir 'bpa-review.json'
  $sqlRun = Join-Path $outdir ('.coop-sql-review.current.' + [System.IO.Path]::GetRandomFileName() + '.json')
  $daxRun = Join-Path $outdir ('.coop-dax-review.current.' + [System.IO.Path]::GetRandomFileName() + '.json')
  $sqlResolutionPath = $null; $daxResolutionPath = $null; $taskResolutionsPath = $null; $promotionPath = $null; $acceptedPath = $null; $sqlPrev = $null; $daxPrev = $null
  try {
  foreach ($temp in @($sqlRun, $daxRun)) { $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); $stream.Dispose() }
  # A suite HTML file always describes one complete current run.
  Remove-Item -LiteralPath (Join-Path $outdir 'suite.html') -Force -ErrorAction SilentlyContinue
  $extra = @(); if ($strict) { $extra = @('--strict') }
  $sqlStandards = @(); $daxStandards = @(); $sqlProvenance = $false; $daxProvenance = $false
  if (-not (Test-Have 'node')) { Coop-Die 'Node is required to resolve and verify review standards provenance' }
  $standardsCli = Join-Path $script:CoopRoot 'lib\standards-cli.mjs'
  $sqlResolutionPath = [System.IO.Path]::GetTempFileName(); $daxResolutionPath = [System.IO.Path]::GetTempFileName(); $taskResolutionsPath = [System.IO.Path]::GetTempFileName(); $promotionPath = [System.IO.Path]::GetTempFileName(); $acceptedPath = [System.IO.Path]::GetTempFileName()
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($taskResolutionsPath, ((& node $standardsCli resolve-many 'sql,dax' $PWD.Path) -join ''), $utf8NoBom)
  [System.IO.File]::WriteAllText($sqlResolutionPath, ((& node $standardsCli resolution-domain $taskResolutionsPath sql) -join ''), $utf8NoBom)
  [System.IO.File]::WriteAllText($daxResolutionPath, ((& node $standardsCli resolution-domain $taskResolutionsPath dax) -join ''), $utf8NoBom)
  $sqlResolution = Get-Content -LiteralPath $sqlResolutionPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $daxResolution = Get-Content -LiteralPath $daxResolutionPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $sqlStandard = [string]$sqlResolution.path; $daxStandard = [string]$daxResolution.path
  if ($sqlStandard) { $sqlStandards = @('--standards', $sqlStandard) }
  if ($daxStandard) { $daxStandards = @('--standards', $daxStandard) }
  $savedEap = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; [System.IO.File]::WriteAllText($acceptedPath, ((& node $standardsCli accepted-run $outdir 2>$null) -join ''), $utf8NoBom); $acceptedRc = $LASTEXITCODE }
  finally { $ErrorActionPreference = $savedEap }
  if ($acceptedRc -eq 0) {
    $accepted = Get-Content -LiteralPath $acceptedPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $sqlJson = [string]$accepted.reports.sql; $daxJson = [string]$accepted.reports.dax
  }

  # --compare: snapshot each linter's previous saved report, then hand it to the linter as
  # --diff-against so it prints a new/fixed/persisting delta (the run overwrites the saved
  # copy via -o, so we compare against the snapshot). A first run has nothing to diff.
  $sqlDiff = @(); $daxDiff = @(); $sqlPrev = $null; $daxPrev = $null; $retainedComparison = [bool]$script:CoopInstallationContext
  if ($compare) {
    if (Test-Path -LiteralPath $sqlJson) { if ($retainedComparison) { $sqlPrev = $sqlJson } else { $sqlPrev = [System.IO.Path]::GetTempFileName(); Copy-Item -LiteralPath $sqlJson -Destination $sqlPrev -Force }; $sqlDiff = @('--diff-against', $sqlPrev) }
    if (Test-Path -LiteralPath $daxJson) { if ($retainedComparison) { $daxPrev = $daxJson } else { $daxPrev = [System.IO.Path]::GetTempFileName(); Copy-Item -LiteralPath $daxJson -Destination $daxPrev -Force }; $daxDiff = @('--diff-against', $daxPrev) }
    if (-not $sqlPrev -and -not $daxPrev) { Coop-Info 'no previous review to compare against yet — this run becomes the baseline' }
  }

  # Run both reviewers first; Node validates the complete envelopes and publishes
  # reports plus bindings as one immutable generation behind one atomic pointer.
  Coop-Head "coop-sql-review check → accepted review generation"
  Invoke-CoopReviewTool 'coop-sql-review' (@('check') + $scope + @('--format','json') + $sqlStandards + @('-o',$sqlRun) + $sqlDiff + $extra)
  $sqlRc = $LASTEXITCODE
  if ($sqlRc -ne 0) { Coop-Warn "coop-sql-review exited $sqlRc" }
  Coop-Head "coop-dax-review check → accepted review generation"
  Invoke-CoopReviewTool 'coop-dax-review' (@('check') + $scope + @('--format','json') + $daxStandards + @('-o',$daxRun) + $daxDiff + $extra)
  $daxRc = $LASTEXITCODE
  if ($daxRc -ne 0) { Coop-Warn "coop-dax-review exited $daxRc" }
  $savedEap = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; [System.IO.File]::WriteAllText($promotionPath, ((& node $standardsCli promote-run $outdir $sqlResolutionPath $sqlRun $daxResolutionPath $daxRun 2>&1) -join "`n"), $utf8NoBom); $promoteRc = $LASTEXITCODE }
  finally { $ErrorActionPreference = $savedEap }
  if ($promoteRc -eq 0) {
    $promotion = Get-Content -LiteralPath $promotionPath -Encoding UTF8 -Raw | ConvertFrom-Json
    $sqlJson = [string]$promotion.reports.sql; $daxJson = [string]$promotion.reports.dax
    $sqlProvenance = $true; $daxProvenance = $true
  } else {
    $provenanceError = Get-Content -LiteralPath $promotionPath -Raw
    Coop-Err "review run rejected: $provenanceError"; $sqlRc = 2; $daxRc = 2
    $rejected = Join-Path $outdir 'rejected'; New-Item -ItemType Directory -Force -Path $rejected | Out-Null
    foreach ($run in @($sqlRun, $daxRun)) { if ((Test-Path -LiteralPath $run -PathType Leaf) -and (Get-Item -LiteralPath $run).Length -gt 0) { Move-Item -LiteralPath $run -Destination (Join-Path $rejected ([System.IO.Path]::GetFileName($run))) -Force -ErrorAction Stop } }
  }
  Remove-Item -LiteralPath $sqlResolutionPath,$daxResolutionPath,$taskResolutionsPath -Force -ErrorAction SilentlyContinue

  $bpaRc = 0
  Remove-Item -LiteralPath $bpaJson -Force -ErrorAction SilentlyContinue   # never let a stale report stand in for this run
  if ($proj) {
    $pyCmd = Get-CoopPython
    if ($pyCmd) {
      $bpaScript = Join-Path $env:COOP_ROOT 'lib\_bpa_runner.py'
      & $pyCmd $bpaScript $proj $bpaJson @scope
      $bpaRc = $LASTEXITCODE
      if (Test-Path -LiteralPath $bpaJson -PathType Leaf) {
        Coop-Head "Tabular Editor BPA → $bpaJson"
        if ($bpaRc -ne 0) { Coop-Warn "Tabular Editor BPA exited $bpaRc" }
      }
    }
  }

  if ($sqlPrev -and -not $retainedComparison) { Remove-Item -LiteralPath $sqlPrev -Force -ErrorAction SilentlyContinue }
  if ($daxPrev -and -not $retainedComparison) { Remove-Item -LiteralPath $daxPrev -Force -ErrorAction SilentlyContinue }

  # Compose the findings onto the lineage docs (unless --skip-docs).
  $ddRc = 0
  if ($skipDocs) {
    Coop-Info 'skipping the lineage-docs step (--skip-docs)'
  } elseif (-not $sqlProvenance -or -not $daxProvenance) {
    Coop-Warn 'skipping lineage-docs composition because this run contains a rejected review report'
  } else {
    Coop-Head 'coop-data-doc build (composing review findings)'
    $ddArgs = @('build', '--non-interactive')
    if ($sqlProvenance) { $ddArgs += '--reviews'; $ddArgs += $sqlJson }
    if ($daxProvenance) { $ddArgs += '--reviews'; $ddArgs += $daxJson }
    if (Test-Path -LiteralPath $bpaJson -PathType Leaf) { $ddArgs += '--reviews'; $ddArgs += $bpaJson }
    Invoke-CoopReviewTool 'coop-data-doc' $ddArgs
    $ddRc = $LASTEXITCODE
    if ($ddRc -eq 1) {
      # Friendly "no config" exit — the findings are still saved; docs are an aid, not a gate.
      Coop-Warn 'lineage docs not set up — findings saved, docs step skipped. Set up lineage docs first: coop data-doc setup   (or /setup-docs in the agent)'
      $ddRc = 0
    } elseif ($ddRc -ne 0) {
      Coop-Err "coop-data-doc build failed (exit $ddRc)"
    } else {
      foreach ($d in @('data-docs-site', 'site')) {
        if (Test-Path -LiteralPath (Join-Path $d 'index.html') -PathType Leaf) { Coop-Ok "Portal: $d/index.html"; break }
      }
    }
  }

  # Summary/HTML publishes only a coherent current SQL+DAX run.
  $py = if ($script:CoopInstallationContext) { $script:CoopReviewVectors.'coop-sql-review'.executable } else { Get-CoopPython }
  if (-not $sqlProvenance -or -not $daxProvenance) {
    Coop-Warn 'skipping suite summary/HTML because the complete review run was not accepted'
  } elseif ($py) {
    $htmlFlag = if ($doHtml) { "1" } else { "0" }
    $suiteHtml = Join-Path $outdir "suite.html"
    $summaryPy = @'
import sys, os
from coop_review_core.suite import load_envelopes, suite_summary, suite_text, suite_html

paths = [p for p in sys.argv[1:4] if os.path.exists(p)]
if not paths:
    sys.exit(0)

try:
    envs = load_envelopes(paths)
    summary = suite_summary(envs)
    print("\n" + suite_text(envs, summary, color=True))

    do_html = sys.argv[4] == "1"
    if do_html:
        html_out = sys.argv[5]
        html_paths = {}
        for env in envs:
            t = env.get("tool")
            if t:
                html_file = os.path.join(os.path.dirname(html_out), f"{t}.html")
                if os.path.exists(html_file):
                    html_paths[t] = f"{t}.html"

        html_tmp = f"{html_out}.{os.getpid()}.tmp"
        try:
            with open(html_tmp, "x", encoding="utf-8") as f:
                f.write(suite_html(envs, summary, html_paths))
                f.flush(); os.fsync(f.fileno())
            os.replace(html_tmp, html_out)
        finally:
            if os.path.exists(html_tmp): os.unlink(html_tmp)
        print(f"Suite HTML Report: {html_out}\n")
except Exception as exc:
    print(f"Suite summary error: {exc}", file=sys.stderr)
'@
    $sqlSummary = if ($sqlProvenance) { $sqlJson } else { '' }
    $daxSummary = if ($daxProvenance) { $daxJson } else { '' }
    $pyFlags = if ($script:CoopInstallationContext) { @('-I','-B','-X','utf8') } else { @() }
    $summaryPy | & $py @pyFlags - $sqlSummary $daxSummary $bpaJson $htmlFlag $suiteHtml
  } else {
    Coop-Ok "Reports: $sqlJson $daxJson $bpaJson"
  }
  Coop-Info "Tip: add these files to coop-data-doc.yml's reviews: list so CI check sees the same inputs."

  # Exit: hard data-doc failures propagate; --strict makes a failing linter exit 2.
  if ($ddRc -ge 2) { exit $ddRc }
  if (-not $sqlProvenance -or -not $daxProvenance) { exit 2 }
  if ($strict) {
    if ($sqlRc -ne 0 -or $daxRc -ne 0 -or $bpaRc -ne 0) { exit 2 }
  }
  exit 0
  } finally {
    if ($retainedComparison) { $sqlPrev = $null; $daxPrev = $null }
    foreach ($temp in @($sqlRun, $daxRun, $sqlResolutionPath, $daxResolutionPath, $taskResolutionsPath, $promotionPath, $acceptedPath, $sqlPrev, $daxPrev)) {
      if ($temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
  }
}


if ($MyInvocation.InvocationName -ne '.') {
  $forwarded = @($args)
  . (Join-Path $PSScriptRoot 'common.ps1')
  if (-not $script:CoopInstallationContext) { throw 'Direct review helper requires beta context' }
  # This dedicated child captures UTF-8 Python/Node output (including contract
  # paths). Change only this process, never the caller or workstation settings.
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
  $vectors = & $script:CoopInstallationContext.tools.node.path (Join-Path $PSScriptRoot 'beta-lifecycle.mjs') review-vectors $env:COOP_BETA_ROOT @forwarded
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $script:CoopReviewVectors = $vectors | ConvertFrom-Json
  Invoke-CoopReview $forwarded
}
