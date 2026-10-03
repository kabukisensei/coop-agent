; NSIS additions to electron-builder's installer for the coop window package
; (master plan D1d). Included through nsis.include in electron-builder.cjs.
;
; customUnInstall runs before the uninstaller deletes the package, so the
; snapshot's scripts are still there: scripts\window-uninstall.ps1 removes the
; `coop` launcher link and the "coop" shortcuts that the package's first launch
; wrote, and only when they point into this install dir (a terminal install's
; own link and shortcuts stay). Best-effort: the script always exits 0 and a
; missing PowerShell leaves the uninstall unaffected.
!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\coop\scripts\window-uninstall.ps1" "$INSTDIR"'
  Pop $0
!macroend
