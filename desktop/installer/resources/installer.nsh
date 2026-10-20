; NSIS additions to electron-builder's installer for the coop window package
; (master plan D1d, F3). Included through nsis.include in electron-builder.cjs.
;
; F3 (Aaron 2026-10-20): coop installs once per machine. The installer is
; per-machine (nsis.perMachine), so Windows asks for an administrator once and
; every account shares the program; each account keeps its own data under its
; user folder (%USERPROFILE%\.coop). The pieces NSIS does not do itself live in
; the snapshot's PowerShell scripts, run with the built-in Windows PowerShell:
;
;   customInit        before anything is written: this account's older
;                     per-user coop (HKCU, %LOCALAPPDATA%\Programs\coop) is
;                     uninstalled completely (not --updated), so its own
;                     uninstaller also drops the `coop` link and "coop"
;                     shortcuts its first launch wrote; the machine shim then
;                     serves the account. ~\.coop is never touched.
;   customInstall     scripts\machine-install.ps1: the machine shim
;                     <app>\bin\coop.cmd on the machine PATH (the `coop`
;                     command for every account), the machine marker and the
;                     "coop update" scheduled task (scripts\auto-update.ps1 as
;                     SYSTEM installs each new release silently).
;   customUnInstall   before the uninstaller deletes the package, so the
;                     snapshot's scripts are still there: window-uninstall.ps1
;                     removes the `coop` launcher link and "coop" shortcuts an
;                     older package's first launch wrote, only when they point
;                     into this install dir; machine-install.ps1 -Remove undoes
;                     the shim, the PATH entry, the marker and the task.
;                     Best-effort: the scripts never fail the uninstall. An
;                     upgrade (the new installer runs this uninstaller with
;                     --updated) keeps everything: the new version installs
;                     into the same folder and re-runs the machine step (D1k).
;   customWelcomePage / customFinishPage   what the installer says.
;
; ${APP_GUID} is electron-builder's uninstall key for this appId (the same in
; every mode); $installMode is "all" for a per-machine install (multiUser.nsh).

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "coop"
  !define MUI_WELCOMEPAGE_TEXT "coop installs once for every account on this computer.$\r$\n$\r$\nEach Windows account keeps its own client's sessions, memory and backups under its user folder.$\r$\n$\r$\nUpdates install themselves overnight.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "coop is installed"
  !define MUI_FINISHPAGE_TEXT "coop is installed for every account on this computer: open coop from the Start Menu or the Desktop, or type coop in a new terminal.$\r$\n$\r$\nUpdates install themselves overnight; nothing to run by hand."
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInit
  ${if} $installMode == "all"
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "InstallLocation"
    ${if} $R2 == ""
      ReadRegStr $R2 HKCU "Software\${APP_GUID}" "InstallLocation"
    ${endIf}
    ${if} $R2 != ""
    ${andIf} ${FileExists} "$R2\Uninstall coop.exe"
      DetailPrint "removing this account's older coop at $R2 (its data under the user folder stays)"
      ExecWait '"$R2\Uninstall coop.exe" /S /currentuser _?=$R2' $R0
      Delete "$R2\Uninstall coop.exe"
      RMDir "$R2"
      DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
      DeleteRegKey HKCU "Software\${APP_GUID}"
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  ${if} $installMode == "all"
    DetailPrint "setting up coop for every account: the coop command, the update task"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\machine-install.ps1" -InstallDir "$INSTDIR"'
    Pop $0
    ${if} $0 != 0
      DetailPrint "machine-install.ps1 exited $0"
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "coop is installed, but the coop command for every account or its update task could not be set up (code $0).$\r$\n$\r$\nRun this as an administrator, then try again:$\r$\npowershell -ExecutionPolicy Bypass -File $\"$INSTDIR\resources\coop\scripts\machine-install.ps1$\" -InstallDir $\"$INSTDIR$\""
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\window-uninstall.ps1" "$INSTDIR"'
    Pop $0
    ${if} $installMode == "all"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\machine-install.ps1" -Remove -InstallDir "$INSTDIR"'
      Pop $0
    ${endIf}
  ${endIf}
!macroend
