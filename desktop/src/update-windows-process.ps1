param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
try { $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ProcessId) }
catch [System.ArgumentException] { [Console]::Out.WriteLine('null'); exit 0 }
try {
  # Hold the process object before reading its creation time. Do not treat an
  # access failure or a process-inspection race as proof that an owner exited.
  $ownedHandle = $ownedProcess.Handle
  $started = $ownedProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  if ($ownedProcess.HasExited) { [Console]::Out.WriteLine('null') }
  else { [Console]::Out.WriteLine('{"pid":' + $ProcessId + ',"startedUtcTicks":"' + $started + '"}') }
} finally { $ownedProcess.Dispose() }
