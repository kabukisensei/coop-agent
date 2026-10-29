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
;                     per-user coop (HKCU InstallLocation, else the folder of
;                     its UninstallString, else %LOCALAPPDATA%\Programs\coop) is
;                     uninstalled completely (not --updated), so its own
;                     uninstaller also drops the `coop` link and "coop"
;                     shortcuts its first launch wrote; the machine shim then
;                     serves the account. ~\.coop is never touched.
;   customInstall     scripts\machine-install.ps1: the machine shim
;                     <app>\bin\coop.cmd on the machine PATH (the `coop`
;                     command for every account), the machine marker, the
;                     "coop update" scheduled task (scripts\auto-update.ps1 as
;                     SYSTEM installs each new release silently), the shared
;                     standards folder, and the removal of EVERY account's
;                     older per-user package, link and icons (elevated, so
;                     the other accounts' copies go too; their ~\.coop stays).
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
;   customCheckAppRunning   electron-builder's own "is coop running" check,
;                     with the installer's step lines around it (below).
;   customWelcomePage / customFinishPage   what the installer says.
;
; What the installer says while it works (Aaron 2026-10-29: the install takes
; minutes and showed only a bar). electron-builder's install section starts
; with SetDetailsPrint none, so on its own the page names no step at all.
; coopStep shows a step on the status line above the bar, then sends
; electron-builder's own lines to the details list only (never shown:
; ShowInstDetails nevershow), so the step stays readable; step 3 shows each of
; machine-install.ps1's lines (nsExec::ExecToLog) on the status line instead:
;   Step 1 of 3  closing coop if it is open (customCheckAppRunning)
;   Step 2 of 3  the previous version's files out, this version's in: the
;                longest step (electron-builder's uninstallOldVersion and
;                installApplicationFiles; no hook between them)
;   Step 3 of 3  machine-install.ps1 (customInstall), each of its lines shown
;
; ${APP_GUID} is electron-builder's uninstall key for this appId (the same in
; every mode); $installMode is "all" for a per-machine install (multiUser.nsh).
;
; The installer is a 32-bit process: "$SYSDIR\WindowsPowerShell" is the 32-bit
; PowerShell under file-system redirection. coopPowerShell picks the 64-bit one
; through Sysnative on a 64-bit Windows (schtasks and the per-account sweep run
; there), else the only one. machine-install.ps1 logs every step to
; %ProgramData%\coop\logs\machine-install.log; the message box names it.

!include x64.nsh
!include FileFunc.nsh
!include WordFunc.nsh

!macro coopPowerShell OUT
  StrCpy ${OUT} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${if} ${RunningX64}
    StrCpy ${OUT} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${endIf}
!macroend

!macro coopStep TEXT
  SetDetailsPrint both
  DetailPrint "${TEXT}"
  SetDetailsPrint listonly
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro coopStep "Step 1 of 3: checking that coop is not running"
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ${if} ${FileExists} "$INSTDIR\Uninstall coop.exe"
      !insertmacro coopStep "Step 2 of 3: replacing coop's program files with this version's (the longest step: several minutes)"
    ${else}
      !insertmacro coopStep "Step 2 of 3: copying coop's program files: the window, Node.js, Pi, Python, Git, the Azure CLI (the longest step: several minutes)"
    ${endIf}
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "coop"
  !define MUI_WELCOMEPAGE_TEXT "coop installs once for every account on this computer.$\r$\n$\r$\nEach Windows account keeps its own client's sessions, memory and backups under its user folder.$\r$\n$\r$\nUpdates install themselves overnight.$\r$\n$\r$\nInstalling takes several minutes, and the first time each account opens coop it sets up that account's tools for a few more; a window shows each step.$\r$\n$\r$\nClick Next to continue."
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
    ${if} $R2 == ""
      ; A v0.37.0 per-user install wrote no InstallLocation: take the folder
      ; from its uninstall command, "<dir>\Uninstall coop.exe" /currentuser.
      ReadRegStr $R3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "UninstallString"
      ${if} $R3 != ""
        StrCpy $R4 $R3 1
        ${if} $R4 == '"'
          StrCpy $R3 $R3 "" 1
          ${WordFind} $R3 '"' "+1" $R3
        ${endIf}
        ${GetParent} $R3 $R2
      ${endIf}
    ${endIf}
    ${if} $R2 == ""
    ${andIf} ${FileExists} "$LOCALAPPDATA\Programs\coop\Uninstall coop.exe"
      StrCpy $R2 "$LOCALAPPDATA\Programs\coop"
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
  ; The folder, for the next installer and for coop doctor (v0.37.0 wrote none).
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "InstallLocation" "$INSTDIR"
  ${if} $installMode == "all"
    !insertmacro coopStep "Step 3 of 3: setting up coop for every account (the coop command, the SQL Server ODBC driver, the update task, older per-account copies)"
    SetDetailsPrint both
    !insertmacro coopPowerShell $R9
    nsExec::ExecToLog '"$R9" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\machine-install.ps1" -InstallDir "$INSTDIR"'
    Pop $0
    ${if} $0 != 0
      DetailPrint "machine-install.ps1 exited $0 (log: %ProgramData%\coop\logs\machine-install.log)"
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "coop is installed, but the coop command for every account, its update task or the removal of older per-account copies did not finish (code $0).$\r$\n$\r$\nThe log: %ProgramData%\coop\logs\machine-install.log$\r$\n$\r$\nRun this as an administrator, then try again:$\r$\npowershell -ExecutionPolicy Bypass -File $\"$INSTDIR\resources\coop\scripts\machine-install.ps1$\" -InstallDir $\"$INSTDIR$\""
      ${endIf}
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro coopPowerShell $R9
    nsExec::ExecToLog '"$R9" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\window-uninstall.ps1" "$INSTDIR"'
    Pop $0
    ${if} $installMode == "all"
      nsExec::ExecToLog '"$R9" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\machine-install.ps1" -Remove -InstallDir "$INSTDIR"'
      Pop $0
    ${endIf}
  ${endIf}
!macroend
