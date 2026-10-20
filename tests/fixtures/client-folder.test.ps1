#!/usr/bin/env pwsh
# The client folder (lib/common.ps1, master plan F1; Aaron 2026-10-20): one Windows
# user is one client, one folder holds all of its repositories, and coop opens there
# every time. Get-CoopClientRootFor (the one root rule, the same fixtures as
# clientRootFor in tests/desktop.test.mjs), Get-CoopContractClientName,
# Get-CoopClientRecord (client.json first; an old home-project.json carried over),
# Register-CoopHomeProjectFile (the carry-over is written once; a search records
# the file), Get-CoopClientLine, Enter-CoopShortcutFolder (enters the root) and
# `coop folders` (bin\coop.ps1, the three places). Offline, no waits, no real home.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_common.ps1')
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$t = Join-Path ([System.IO.Path]::GetTempPath()) ('coop-client-folder-' + [guid]::NewGuid().ToString('N'))

$saved = Save-Env @('HOME', 'USERPROFILE', 'COOP_DIR', 'COOP_MACHINE_DIR', 'NO_COLOR', 'COOP_PROJECT_YML', 'COOP_SKIP_AZ', 'COOP_NO_ONBOARD', 'COOP_NO_MODEL_LOGIN', 'COOP_SKIP_EXT_CHECK')
try {
  $home_ = New-SandboxHome (Join-Path $t 'home')
  $env:HOME = $home_
  $env:USERPROFILE = $home_
  # The profile is <COOP_DIR>\.coop in-process (lib/common.ps1 reads $HOME, the
  # automatic variable, for the default); the child `coop folders` reads the same.
  $env:COOP_DIR = $home_
  $env:COOP_MACHINE_DIR = Join-Path $t 'machine'
  $env:NO_COLOR = '1'
  . (Join-Path $root 'lib\common.ps1')
  $profile = Join-Path $home_ '.coop'
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  function Full([string]$p) { return [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/') }

  # The layout tests/desktop.test.mjs uses: a client folder with a home repository
  # beside two others, a lone repository, a user folder with a repository two levels down.
  $client = Join-Path $t 'client'
  $homeRepo = Join-Path $client 'contoso-coop'
  $homeFile = Join-Path $homeRepo '.coop\project.yml'
  New-Item -ItemType Directory -Force -Path (Join-Path $homeRepo '.coop'), (Join-Path $homeRepo 'src'), (Join-Path $client 'analytics\.git'), (Join-Path $client 'analytics\src'), (Join-Path $client 'reports\.git') | Out-Null
  [System.IO.File]::WriteAllText($homeFile, "profile:`n  client: 'Contoso Retail'`nrepositories:`n  analytics:`n    local_path: '../analytics'`n  reports:`n    local_path: `"../reports`"`n", $utf8)
  $solo = Join-Path $t 'solo'
  $acmeRepo = Join-Path $solo 'acme'
  $acmeFile = Join-Path $acmeRepo '.coop\project.yml'
  New-Item -ItemType Directory -Force -Path (Join-Path $acmeRepo '.coop'), (Join-Path $acmeRepo '.git'), (Join-Path $acmeRepo 'src') | Out-Null
  [System.IO.File]::WriteAllText($acmeFile, "profile:`n  client: `"Acme`"   # the client`nrepositories:`n  self:`n    local_path: '.'`n", $utf8)
  $user = Join-Path $t 'user'
  $fabricRepo = Join-Path $user 'devops\fabric'
  $fabricFile = Join-Path $fabricRepo '.coop\project.yml'
  New-Item -ItemType Directory -Force -Path (Join-Path $fabricRepo '.coop'), (Join-Path $fabricRepo '.git') | Out-Null
  [System.IO.File]::WriteAllText($fabricFile, "profile:`n  client: Fabrikam`n", $utf8)

  # --- the root rule ---------------------------------------------------------------
  $cases = @(
    @{ File = $homeFile;   Start = (Join-Path $homeRepo 'src');            Want = $client;   Why = 'home repository opened directly: the client folder is its parent (siblings listed)' },
    @{ File = $acmeFile;   Start = (Join-Path $acmeRepo 'src');            Want = $acmeRepo; Why = 'a lone repository is the client folder' },
    @{ File = $acmeFile;   Start = $acmeRepo;                              Want = $acmeRepo; Why = 'the repository itself' },
    @{ File = $homeFile;   Start = (Join-Path $client 'analytics\src');    Want = $client;   Why = 'found beside the launch folder''s repository: the folder holding both' },
    @{ File = $acmeFile;   Start = $solo;                                  Want = $solo;     Why = 'found one level down: the launch folder' },
    @{ File = $fabricFile; Start = $user;                                  Want = $user;     Why = 'found two levels down: the launch folder' },
    @{ File = $homeFile;   Start = '';                                     Want = $client;   Why = 'no launch folder (carry-over), siblings listed: the parent' },
    @{ File = $acmeFile;   Start = '';                                     Want = $acmeRepo; Why = 'no launch folder, nothing beside it: the repository' },
    @{ File = $fabricFile; Start = '';                                     Want = $fabricRepo; Why = 'no launch folder, no repositories block: the repository' })
  foreach ($c in $cases) {
    $got = Get-CoopClientRootFor $c.File $c.Start
    if ((Full $got) -eq (Full $c.Want)) { Ok "root rule: $($c.Why)" } else { Ko "root rule: $($c.Why): got $got, expected $($c.Want)" }
  }
  $names = @((Get-CoopContractClientName $homeFile), (Get-CoopContractClientName $acmeFile), (Get-CoopContractClientName $fabricFile), (Get-CoopContractClientName (Join-Path $t 'none.yml')))
  if (($names -join '|') -eq 'Contoso Retail|Acme|Fabrikam|') { Ok 'the client name comes from profile.client (single quotes, double quotes with a comment, bare)' } else { Ko "client names: $($names -join '|')" }

  # --- the record: nothing, the old file carried over, client.json ---------------------
  $record = Get-CoopClientRecord
  if (-not $record.Exists -and -not $record.Carried -and $record.Root -eq '') { Ok 'no record: Exists is false' } else { Ko "empty record: $($record | ConvertTo-Json -Compress)" }
  if ((Get-CoopClientLine $solo) -eq "Client: not set yet · folder $solo") { Ok 'the client line before a record: not set yet, the folder' } else { Ko "client line (none): $(Get-CoopClientLine $solo)" }
  $oldRecord = Join-Path $profile 'home-project.json'
  $newRecord = Join-Path $profile 'client.json'
  [System.IO.File]::WriteAllText($oldRecord, (@{ schema_version = 1; project_file = $homeFile } | ConvertTo-Json -Compress) + "`n", $utf8)
  $record = Get-CoopClientRecord
  if ($record.Carried -and $record.Exists -and $record.Client -eq 'Contoso Retail' -and (Full $record.Root) -eq (Full $client) -and $record.ProjectFile -eq $homeFile) { Ok 'only home-project.json: carried over in memory with the root the rule gives' } else { Ko "carried record: $($record | ConvertTo-Json -Compress)" }
  if (-not (Test-Path -LiteralPath $newRecord)) { Ok 'reading writes nothing' } else { Ko 'Get-CoopClientRecord wrote client.json' }
  if ((Get-CoopHomeProjectFile) -eq $homeFile) { Ok 'Get-CoopHomeProjectFile reads the carried-over file' } else { Ko "Get-CoopHomeProjectFile: $(Get-CoopHomeProjectFile)" }
  $recorded = Register-CoopHomeProjectFile $solo
  if ((Full $recorded) -eq (Full $client) -and (Test-Path -LiteralPath $newRecord)) { Ok 'the launch writes the carried-over record once and returns its root' } else { Ko "Register (carry-over): $recorded; client.json exists: $(Test-Path -LiteralPath $newRecord)" }
  $doc = Get-Content -LiteralPath $newRecord -Raw | ConvertFrom-Json
  if ($doc.schema_version -eq 1 -and $doc.client -eq 'Contoso Retail' -and (Full $doc.root) -eq (Full $client) -and $doc.project_file -eq $homeFile) { Ok 'client.json: schema_version, client, root, project_file' } else { Ko "client.json: $(Get-Content -LiteralPath $newRecord -Raw)" }
  if (Test-Path -LiteralPath $oldRecord) { Ok 'the old file stays (harmless)' } else { Ko 'the old file was removed' }
  if ((Register-CoopHomeProjectFile $solo) -eq '') { Ok 'a second launch records nothing new' } else { Ko 'the second launch recorded again' }
  $line = Get-CoopClientLine $solo
  if ($line -eq "Client: Contoso Retail · folder $(Full $client) · project file $homeFile") { Ok "the client line: $line" } else { Ko "client line: $line" }
  $recordedLine = Get-CoopClientRecordedLine $client
  if ($recordedLine -match "^coop now opens this client's folder every time: " -and $recordedLine -match 'File > Switch client' -and $recordedLine -match 'coop project home <folder>') { Ok 'the one recorded line names the folder and both ways to change it' } else { Ko "recorded line: $recordedLine" }
  [System.IO.File]::WriteAllText($oldRecord, (@{ schema_version = 1; project_file = $acmeFile } | ConvertTo-Json -Compress) + "`n", $utf8)
  if ((Get-CoopClientRecord).ProjectFile -eq $homeFile) { Ok 'client.json wins over the old file' } else { Ko 'the old file shadowed client.json' }

  # --- the shortcut enters the root, not the repository ---------------------------------
  # Enter-CoopShortcutFolder compares with $HOME, the automatic variable (read-only,
  # not constant): point it at the sandbox for these checks, and put it back.
  $realHome = $HOME
  try {
    Set-Variable -Name HOME -Value $home_ -Force -Scope Global
    Push-Location -LiteralPath $home_
    try {
      $entered = Enter-CoopShortcutFolder
      if ((Full $entered) -eq (Full $client) -and (Full (Get-Location).ProviderPath) -eq (Full $client)) { Ok 'a shortcut launch from the user folder enters the client folder' } else { Ko "Enter-CoopShortcutFolder: $entered, now in $((Get-Location).ProviderPath)" }
    } finally { Pop-Location }
    Push-Location -LiteralPath $solo
    try { if ((Enter-CoopShortcutFolder) -eq '') { Ok 'elsewhere, a shortcut launch stays where it is' } else { Ko 'Enter-CoopShortcutFolder moved from a folder that is not the user folder' } } finally { Pop-Location }
  } finally { Set-Variable -Name HOME -Value $realHome -Force -Scope Global }

  # --- a folder chosen without a project file: the file is filled in later, the root kept ---
  $plain = Join-Path $t 'plain'
  New-Item -ItemType Directory -Force -Path $plain | Out-Null
  if (Save-CoopClientRecord -ProjectFile '' -Root $plain -Client '') { Ok 'a folder without a project file is still a record' } else { Ko 'Save-CoopClientRecord refused an empty project file' }
  if ((Get-CoopClientLine) -eq "Client: unnamed · folder $(Full $plain) · project file none yet") { Ok 'the client line without a name or file' } else { Ko "client line (plain): $(Get-CoopClientLine)" }
  $filled = Register-CoopHomeProjectFile (Join-Path $acmeRepo 'src')
  $doc = Get-Content -LiteralPath $newRecord -Raw | ConvertFrom-Json
  if ((Full $filled) -eq (Full $plain) -and (Full $doc.root) -eq (Full $plain) -and $doc.project_file -eq $acmeFile -and $doc.client -eq 'Acme') { Ok 'a later launch that finds a file fills it in and keeps the chosen folder' } else { Ko "fill-in: $filled / $(Get-Content -LiteralPath $newRecord -Raw)" }

  # --- a fresh profile: the first launch's search records root by the rule ---------------
  Remove-Item -LiteralPath $newRecord, $oldRecord -Force
  $first = Register-CoopHomeProjectFile $user
  $doc = Get-Content -LiteralPath $newRecord -Raw | ConvertFrom-Json
  if ((Full $first) -eq (Full $user) -and (Full $doc.root) -eq (Full $user) -and $doc.project_file -eq $fabricFile -and $doc.client -eq 'Fabrikam') { Ok 'first launch from the user folder: the repository two levels down is found, the user folder is the root' } else { Ko "first launch: $first / $(Get-Content -LiteralPath $newRecord -Raw)" }
  if ((Save-CoopHomeProjectFile -Path $homeFile -Root $client) -eq (Full $client)) { Ok 'coop project home <folder>: the folder given is the root' } else { Ko 'Save-CoopHomeProjectFile with -Root' }

  # --- coop folders: the three places ---------------------------------------------------
  $env:COOP_SKIP_AZ = '1'; $env:COOP_NO_ONBOARD = '1'; $env:COOP_NO_MODEL_LOGIN = '1'; $env:COOP_SKIP_EXT_CHECK = '1'
  $so = Join-Path $t 'folders.out'; $se = Join-Path $t 'folders.err'; $in = Join-Path $t 'folders.in'
  [System.IO.File]::WriteAllText($in, '')
  $p = Start-Process -FilePath $psExe -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'bin\coop.ps1') + '"'), 'folders') -WorkingDirectory $solo `
    -PassThru -NoNewWindow -RedirectStandardInput $in -RedirectStandardOutput $so -RedirectStandardError $se
  $null = $p.Handle
  $p.WaitForExit()
  $out = [System.IO.File]::ReadAllText($so) + [System.IO.File]::ReadAllText($se)
  $lines = @($out -split "`r?`n" | Where-Object { $_ -match '^(this machine|this client|the repository)\s' })
  if ($p.ExitCode -eq 0 -and $lines.Count -eq 3) { Ok 'coop folders prints three rows: this machine, this client, the repository' } else { Ko "coop folders: rc=$($p.ExitCode)" $out }
  if ($lines.Count -eq 3 -and $lines[0] -match [regex]::Escape($env:COOP_MACHINE_DIR) -and $lines[0] -match 'the program, the standards, your name and preferences') { Ok 'this machine: the machine folder and what it holds' } else { Ko "row 1: $($lines[0])" }
  if ($lines.Count -eq 3 -and $lines[1] -match [regex]::Escape($profile) -and $lines[1] -match 'client.json') { Ok 'this client: the profile folder, with the client folder record' } else { Ko "row 2: $($lines[1])" }
  if ($lines.Count -eq 3 -and $lines[2] -match [regex]::Escape((Join-Path $homeRepo '.coop')) -and $lines[2] -match "the team's project file") { Ok 'the repository: the .coop folder of the recorded project file' } else { Ko "row 3: $($lines[2])" }
} catch {
  Ko "fixture error: $($_.Exception.Message)" ($_.ScriptStackTrace)
} finally {
  Restore-Env $saved
  Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
}
exit $fail
