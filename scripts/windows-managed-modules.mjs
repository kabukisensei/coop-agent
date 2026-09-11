// Fixed OS module imports avoid Windows PowerShell's cold automatic discovery.
// Restore the caller's policy after loading only the cmdlets the bootstrap uses.
export const WINDOWS_MANAGED_MODULE_PRELUDE = String.raw`$coopModuleAutoLoading = $PSModuleAutoLoadingPreference
$PSModuleAutoLoadingPreference = 'None'
try {
  foreach ($coopModuleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
    $coopModuleManifest = [IO.Path]::Combine($PSHOME, 'Modules', $coopModuleName, ($coopModuleName + '.psd1'))
    Microsoft.PowerShell.Core\Import-Module -Name $coopModuleManifest -ErrorAction Stop
  }
} finally {
  $PSModuleAutoLoadingPreference = $coopModuleAutoLoading
}
if ($env:COOP_RUNTIME_STARTUP_TRACE -eq '1') { [Console]::Error.WriteLine('[coop-startup] bootstrap-modules-ready') }
`;
