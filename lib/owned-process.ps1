# Use Win32 argv quoting explicitly: Windows PowerShell 5.1's native binder loses
# empty arguments and embedded quotes. A job owns only the process started here
# and its descendants, and closes on exit/cancel/timeout (never all node.exe).
# https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
function Invoke-CoopWindowsOwnedProcess {
  param([string]$FilePath, [string[]]$ArgumentVector, [int]$TimeoutMilliseconds = 0, [switch]$ReadOnly)
  $ErrorActionPreference = 'Stop'
  $global:LASTEXITCODE = 1
  if (-not $script:CoopInstallationContext) { throw 'Owned process launch requires a validated beta context' }
  # Emit only the four native signatures in memory. Add-Type's Windows 5.1
  # compiler writes temporary DLLs and fails for Unicode TEMP paths.
  if (-not ('CoopBeta.NativeJob' -as [type])) {
    $assemblyName = New-Object Reflection.AssemblyName('CoopBeta.NativeJob')
    if ($PSVersionTable.PSEdition -eq 'Core') {
      $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
    } else {
      $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
    }
    $module = $assembly.DefineDynamicModule('NativeJob')
    $type = $module.DefineType('CoopBeta.NativeJob', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
    $signatures = @(
      @{ Name='CreateJobObject'; Entry='CreateJobObjectW'; Return=[IntPtr]; Parameters=[type[]]@([IntPtr], [string]) },
      @{ Name='SetInformationJobObject'; Entry='SetInformationJobObject'; Return=[bool]; Parameters=[type[]]@([IntPtr], [int], [IntPtr], [uint32]) },
      @{ Name='AssignProcessToJobObject'; Entry='AssignProcessToJobObject'; Return=[bool]; Parameters=[type[]]@([IntPtr], [IntPtr]) },
      @{ Name='CloseHandle'; Entry='CloseHandle'; Return=[bool]; Parameters=[type[]]@([IntPtr]) }
    )
    foreach ($signature in $signatures) {
      $method = $type.DefinePInvokeMethod($signature.Name, 'kernel32.dll', $signature.Entry,
        [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
        $signature.Return, $signature.Parameters, [Runtime.InteropServices.CallingConvention]::Winapi,
        [Runtime.InteropServices.CharSet]::Unicode)
      $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    }
    $null = $type.CreateType()
  }
  $quoted = foreach ($value in $ArgumentVector) {
    $escaped = [regex]::Replace([string]$value, '(\\*)"', '$1$1\"')
    '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
  }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $FilePath
  $start.Arguments = $quoted -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = [Console]::IsInputRedirected -and [Console]::IsOutputRedirected -and [Console]::IsErrorRedirected
  # Keep a real terminal attached for the TUI; when our caller uses pipes, copy
  # raw bytes instead of PowerShell's text pipeline (which changes encoding).
  $start.RedirectStandardOutput = [Console]::IsOutputRedirected
  $start.RedirectStandardError = [Console]::IsErrorRedirected
  # Inherit stdin directly. On Windows PowerShell 5.1, CopyToAsync into the
  # redirected FileStream buffers short answers until EOF, deadlocking JSONL
  # prompts. Inheritance preserves incremental bytes, Unicode and EOF in both
  # piped and real-terminal callers without another copy loop.
  $start.RedirectStandardInput = $false
  $start.WorkingDirectory = $PWD.Path
  $owned = New-Object Diagnostics.Process
  $owned.StartInfo = $start
  $job = [CoopBeta.NativeJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'Cannot create beta process job' }
  $attached = $false
  $started = $false
  $lease = $null
  try {
    # One beta session or mutating lifecycle operation at a time. DeleteOnClose
    # releases ownership even after a killed shell; never break another lock.
    # Initial installation claims ownership with an exclusive marker write.
    # Before that claim, creating a lock would make an empty destination fail
    # validation. Never exempt lock files from the empty-root requirement.
    $identity = Join-Path $script:CoopInstallationContext.root '.coop-beta.json'
    if (-not $ReadOnly -and (Test-Path -LiteralPath $identity -PathType Leaf)) {
      $lock = Join-Path $script:CoopInstallationContext.root '.coop-beta.lock'
      try {
        $lease = New-Object IO.FileStream($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
      } catch { throw 'Beta is busy or a lifecycle ownership lock exists; no operation started' }
    }
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: the flag is at byte 16 on both
    # Windows ABIs; zero all other limits. Class 9, KILL_ON_JOB_CLOSE (0x2000).
    $size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
      [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $size), 0, $buffer, $size)
      [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 16, 0x2000)
      if (-not [CoopBeta.NativeJob]::SetInformationJobObject($job, 9, $buffer, $size)) { throw 'Cannot configure beta process job' }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    $started = $owned.Start()
    if (-not $started) { throw 'Beta process did not start' }
    if (-not [CoopBeta.NativeJob]::AssignProcessToJobObject($job, $owned.Handle)) { throw 'Cannot attach beta process to its job' }
    $attached = $true
    $outputCopy = $null; $errorCopy = $null
    if ($start.RedirectStandardOutput) { $outputCopy = $owned.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()) }
    if ($start.RedirectStandardError) { $errorCopy = $owned.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError()) }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not $owned.WaitForExit(100)) {
      if ($script:CoopEntryParent -and $script:CoopEntryParent.HasExited) { throw 'Beta entry owner exited' }
      if ($TimeoutMilliseconds -gt 0 -and $watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) { throw 'Owned beta process exceeded its deadline' }
    }
    $global:LASTEXITCODE = $owned.ExitCode
    # Reap descendants before draining output: a detached child can retain pipes.
    $null = [CoopBeta.NativeJob]::CloseHandle($job)
    $job = [IntPtr]::Zero
    if ($outputCopy) { $null = $outputCopy.GetAwaiter().GetResult() }
    if ($errorCopy) { $null = $errorCopy.GetAwaiter().GetResult() }
  } finally {
    if ($job -ne [IntPtr]::Zero) { $null = [CoopBeta.NativeJob]::CloseHandle($job) }
    # If assignment failed, terminate only the process just started. Normal
    # completion/cancellation uses the job, which also reaps descendants.
    if ($started -and -not $attached -and -not $owned.HasExited) { $owned.Kill() }
    $owned.Dispose()
    if ($lease) { $lease.Dispose() }
  }
}
