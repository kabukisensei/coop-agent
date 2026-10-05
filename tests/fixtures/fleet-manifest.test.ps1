#!/usr/bin/env pwsh
# Release-manifest driven reproducible fleet, in process:
#   - Coop-ManifestGet / Coop-Manifest*Spec / Coop-ManifestStatus read dotted paths
#   - the manifest's version/package contract against the PowerShell consumers
#   - Get-CoopFleetPlan covers every manifest member; -Edge / -NoFabric variants
# Nothing is installed or launched (tests/run.ps1 covers `update --check`;
# tests/fixtures/fleet-execution.test.ps1 runs the install/update/sync units
# against stubs). Never touches the real ~/.coop (temp HOME).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-fleet-manifest-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'COOP_NO_ONBOARD', 'COOP_SKIP_AZ', 'COOP_RELEASE_MANIFEST', 'NO_COLOR')
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $t 'home'), (Join-Path $t 'agent') | Out-Null
  $env:HOME = Join-Path $t 'home'
  $env:USERPROFILE = $env:HOME
  $env:COOP_DIR = Join-Path $t 'coop-dir'
  $env:COOP_AGENT_DIR = Join-Path $t 'agent'
  $env:PI_CODING_AGENT_DIR = $env:COOP_AGENT_DIR
  $env:COOP_NO_ONBOARD = '1'
  $env:COOP_SKIP_AZ = '1'
  $env:NO_COLOR = '1'
  Remove-Item Env:\COOP_RELEASE_MANIFEST -ErrorAction SilentlyContinue

  . (Join-Path $root 'lib\common.ps1')

  # --- manifest helpers --------------------------------------------------------
  if ((Coop-ManifestGet -Key 'pi.version') -ceq '0.87.1') { Ok 'Coop-ManifestGet pi.version' } else { Ko "Coop-ManifestGet pi.version (got '$(Coop-ManifestGet -Key 'pi.version')')" }
  if ((Coop-ManifestGet -Key 'node.min') -ceq '22.19.0') { Ok 'Coop-ManifestGet node.min' } else { Ko 'Coop-ManifestGet node.min' }
  if ((Coop-ManifestGet -Key 'extensions.pi-mcp-adapter') -ceq '3.3.0') { Ok 'Coop-ManifestGet extensions.pi-mcp-adapter' } else { Ko 'Coop-ManifestGet extensions.pi-mcp-adapter' }
  if ((Coop-ManifestGet -Key 'python_tools.coop-data-doc') -ceq '1.3.1') { Ok 'Coop-ManifestGet python_tools.coop-data-doc' } else { Ko 'Coop-ManifestGet python_tools.coop-data-doc' }
  if ((Coop-ManifestGet -Key 'missing.key') -eq '') { Ok 'Coop-ManifestGet missing key returns empty' } else { Ko 'missing key should return empty' }
  if ((Coop-ManifestExtensionSpec 'pi-mcp-adapter') -ceq 'npm:pi-mcp-adapter@3.3.0') { Ok 'literal extension spec: pi-mcp-adapter' } else { Ko 'extension spec mismatch' }
  if ((Coop-ManifestExtensionSpec '@juicesharp/rpiv-ask-user-question') -ceq 'npm:@juicesharp/rpiv-ask-user-question@2.12.0') { Ok 'literal scoped extension spec' } else { Ko 'scoped extension spec mismatch' }
  if ((Coop-ManifestExtensionSpec '@xl0/pi-lovely-rename') -ceq 'npm:@xl0/pi-lovely-rename@0.1.5') { Ok 'literal session-naming extension spec (N1)' } else { Ko 'session-naming extension spec mismatch' }
  if ((Coop-ManifestPythonSpec 'fabric-cicd') -ceq 'fabric-cicd==1.3.0') { Ok 'literal python spec: fabric-cicd' } else { Ko 'python spec mismatch' }
  if ((Coop-ManifestNpmToolSpec '@microsoft/powerbi-report-authoring-cli') -ceq '@microsoft/powerbi-report-authoring-cli@0.4.0') { Ok 'literal npm tool spec' } else { Ko 'npm tool spec mismatch' }
  if ((Coop-ManifestExtensionSpec 'not-a-fleet-member') -eq '') { Ok 'unknown extension has no spec' } else { Ko 'unknown extension produced a spec' }

  # --- manifest version/package contract (Python: JSON + lib/_yaml.py reader) ----
  $py = Get-CoopPython
  if (-not $py) { Ko 'python3 unavailable for the manifest contract check' }
  else {
    $contract = @'
import json, pathlib, sys
r=pathlib.Path(sys.argv[1]); m=json.load(open(r/'config/release-manifest.json'))
assert m['coop_version']==(r/'VERSION').read_text().strip()
for p in ['@microsoft/fabric-mcp','@azure-devops/mcp']:
    assert p in m['mcp_servers']
# Microsoft Learn is a direct HTTP entry (U1): the mcp-remote bridge is gone.
assert 'mcp-remote' not in json.dumps(m)
# powerbi-mcp-server ignores --readonly and exposes refresh_dataset (#93): retired.
assert 'powerbi-mcp-server' not in json.dumps(m)
assert '@microsoft/powerbi-modeling-mcp' in m['npm_tools']
# Report Authoring 0.4.0 declares `@microsoft/powerbi-desktop-bridge-cli: ^1.0.0`
# (master plan section 6): the global Bridge pin must satisfy that range.
assert m['npm_tools']['@microsoft/powerbi-desktop-bridge-cli'] == '1.0.0'
assert m['npm_tools']['@microsoft/powerbi-report-authoring-cli'] == '0.4.0'
for p in ['pi-mcp-adapter','pi-hermes-memory','pi-better-openai','pi-web-access','@juicesharp/rpiv-ask-user-question','@juicesharp/rpiv-todo','@xl0/pi-lovely-rename']:
    assert p in m['extensions']
# context-mode is retired (U1): Remove-CoopRetiredExtensions uninstalls it.
assert 'context-mode' not in m['extensions']
# Manifest is authoritative: the lifecycle scripts read it through one plan
# (Get-CoopFleetPlan, checked below) and carry NO hard-coded copy of the fleet
# (master plan S2, #222); every generated MCP package must resolve from it.
import re
rd=lambda p:(r/p).read_text(encoding='utf-8-sig')
scripts={n:rd('scripts/'+n) for n in ['install.ps1','update.ps1','sync.ps1','uninstall.ps1']}
# No quoted fleet member ('name' / "name") in any lifecycle script: a settings
# file path or a comment may name one, a list literal may not.
quoted=lambda name: re.compile("['\"]"+re.escape(name)+"['\"]")
for section in ('extensions','python_tools','npm_tools'):
    for p in m[section]:
        for n,text in scripts.items():
            assert not quoted(p).search(text), (section,p,n)
# The scripts converge through the shared functions, never their own `pi install`
# / `pipx install` / `npm install -g` loops.
for n in ('install.ps1','update.ps1'):
    assert not re.search(r'&\s*pi\s+(install|update)\b', scripts[n]), n
for n in ('install.ps1','update.ps1'):
    assert 'Invoke-CoopPiConverge' in scripts[n] and 'Invoke-CoopPipxConverge' in scripts[n] and 'Invoke-CoopNpmToolsConverge' in scripts[n], n
    assert "scripts\\sync.ps1" in scripts[n], n
assert 'Sync-CoopExtensionFleet' in scripts['sync.ps1']
import importlib.util
spec=importlib.util.spec_from_file_location('mcp_config',r/'lib/mcp_config.py'); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
all_versions={**m['extensions'],**m['npm_tools'],**m['mcp_servers']}
# Direct HTTP servers (value None) need no package; every npm-backed one must be pinned.
assert {v for v in mod.SERVER_PACKAGES.values() if v} <= set(all_versions)
assert json.load(open(r/'config/mcp.example.json'))['mcpServers']=={}
# config/defaults.yml carries no second copy of any pin: only the Pi floor.
spec=importlib.util.spec_from_file_location('coop_yaml',r/'lib/_yaml.py'); y=importlib.util.module_from_spec(spec); spec.loader.exec_module(y)
d=y._load_fallback((r/'config/defaults.yml').read_text(encoding='utf-8'))
assert set(d.get('tested_with',{}))=={'pi_min'}, d.get('tested_with')
for key in ('pi','pi_extensions','coop_extensions','python_tools','fabric_cli','npm_authoring_tools'):
    assert key not in d, key
'@
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $cOut = @($contract | & $py - $root 2>&1 | ForEach-Object { "$_" })
    $cRc = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($cRc -eq 0) { Ok 'manifest version/package contract' } else { Ko 'manifest contract failed' ($cOut -join "`n") }
  }
  $updateText = [System.IO.File]::ReadAllText((Join-Path $root 'scripts\update.ps1'))
  if ($updateText.Contains('pi update --extensions')) { Ko 'normal update still invokes pi update --extensions' } else { Ok 'normal update has no unpinned extension update path' }

  # --- the fleet plan covers every manifest member (S2, #222) ---------------------
  $manifest = Get-Content -LiteralPath (Join-Path $root 'config\release-manifest.json') -Raw | ConvertFrom-Json
  $plan = Get-CoopFleetPlan
  $planExt = @($plan.Extensions | ForEach-Object { $_.Name })
  $wantExt = @($manifest.extensions.PSObject.Properties.Name)
  if ((Compare-Object $planExt $wantExt).Count -eq 0 -and @($plan.Extensions | Where-Object { $_.Spec -ne "npm:$($_.Name)@$($_.Pin)" }).Count -eq 0) { Ok 'Get-CoopFleetPlan lists every manifest extension with its npm:name@pin spec' } else { Ko "plan extensions: $($planExt -join ', ')" }
  $planPy = @($plan.PythonTools | ForEach-Object { $_.Name }) + @($plan.Fabric.Name) + @($plan.FabricRuntime)
  $wantPy = @($manifest.python_tools.PSObject.Properties.Name)
  if ((Compare-Object $planPy $wantPy).Count -eq 0 -and $plan.Fabric.Name -ceq 'ms-fabric-cli' -and $plan.Fabric.Spec -ceq "ms-fabric-cli==$($manifest.python_tools.'ms-fabric-cli')") { Ok 'Get-CoopFleetPlan maps every manifest python tool (coop tools, Fabric CLI, runtime libraries)' } else { Ko "plan python tools: $($planPy -join ', ')" }
  $planNpm = @($plan.NpmTools | ForEach-Object { $_.Name })
  $wantNpm = @($manifest.npm_tools.PSObject.Properties.Name | Where-Object { $isWindowsHost -or $_ -ne '@microsoft/powerbi-desktop-bridge-cli' })
  if ((Compare-Object $planNpm $wantNpm).Count -eq 0 -and @($plan.NpmTools | Where-Object { $_.Spec -ne "$($_.Name)@$($_.Pin)" }).Count -eq 0) { Ok 'Get-CoopFleetPlan lists every manifest npm tool at its pin (Desktop Bridge on Windows only)' } else { Ko "plan npm tools: $($planNpm -join ', ')" }
  if ($plan.PiSpec -ceq "$($manifest.pi.package)@$($manifest.pi.version)") { Ok 'Get-CoopFleetPlan pins Pi to the manifest' } else { Ko "plan pi spec: $($plan.PiSpec)" }
  $edge = Get-CoopFleetPlan -Edge -NoFabric
  if ($edge.PiSpec -ceq $manifest.pi.package -and $null -eq $edge.Fabric -and @($edge.PythonTools | Where-Object { $_.Spec -ne $_.Name }).Count -eq 0 -and @($edge.NpmTools | Where-Object { $_.Spec -ne $_.Name }).Count -eq 0 -and @($edge.Extensions | Where-Object { $_.Spec -ne "npm:$($_.Name)@$($_.Pin)" }).Count -eq 0) { Ok '-Edge drops the Pi and tool pins, keeps the extensions pinned; -NoFabric drops the Fabric CLI' } else { Ko "edge plan: pi=$($edge.PiSpec) fabric=$($edge.Fabric)" }

  # --- status classifier ---------------------------------------------------------
  $cases = @(
    @('0.80.2', '0.80.2', 'ok', 'exact match'),
    @('0.80.1', '0.80.2', 'older', 'older'),
    @('0.81.0', '0.80.2', 'newer-than-tested', 'newer than tested'),
    @('0.80.3', '0.80.2', 'wrong-version', 'patch drift'),
    @('', '0.80.2', 'missing', 'missing'),
    @('0.80.2', '', 'not-applicable', 'no expected -> not-applicable')
  )
  foreach ($c in $cases) {
    $got = Coop-ManifestStatus -Installed $c[0] -Expected $c[1]
    if ($got -ceq $c[2]) { Ok "status: $($c[3])" } else { Ko "status: $($c[3]) (got '$got', want '$($c[2])')" }
  }
}
finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
if ($fail -eq 0) { Write-Host '  fleet-manifest tests passed' } else { Write-Host "  $G_CROSS fleet-manifest tests FAILED" }
exit $fail
