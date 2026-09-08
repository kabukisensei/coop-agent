# Long-path variant of electron-builder's atomic uninstall helpers (MIT).
# Keep update failure restoration and ordinary uninstall behavior in sync with
# app-builder-lib/templates/nsis/uninstaller.nsh. Extended Win32 paths work with
# the bundled NSIS 3.0.4.1 without requiring a machine long-path policy change.
!ifdef BUILD_UNINSTALLER
Function un.coopAtomicRMDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "\\?\$INSTDIR$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    # Never traverse junctions/symlinks into files outside this installation.
    # An unreadable entry (-1) also fails closed. Previously moved files are
    # restored by the caller before it aborts the upgrade.
    System::Call 'kernel32::GetFileAttributesW(w "\\?\$INSTDIR$R0\$R2") i .R3'
    IntOp $R3 $R3 & 0x400
    IntCmp $R3 0 +3
    StrCpy $R3 "\\?\$INSTDIR$R0\$R2"
    Goto done

    IfFileExists "\\?\$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "\\?\$PLUGINSDIR\old-install$R0\$R2"

      Push "$R0\$R2"
      Call un.coopAtomicRMDir
      Pop $R3

      ${if} $R3 != 0
        Goto done
      ${endIf}

      Goto continue

    isNotDir:
      ClearErrors
      Rename "\\?\$INSTDIR$R0\$R2" "\\?\$PLUGINSDIR\old-install$R0\$R2"

      # Ignore errors when renaming ourselves.
      StrCmp "$R0\$R2" "${UNINSTALL_FILENAME}" 0 +2
      ClearErrors

      IfErrors 0 +3
      StrCpy $R3 "\\?\$INSTDIR$R0\$R2"
      Goto done

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R3 0

  done:
    FindClose $R1

    StrCpy $R0 $R3

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.coopRestoreFiles
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "\\?\$PLUGINSDIR\old-install$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "\\?\$PLUGINSDIR\old-install$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "\\?\$INSTDIR$R0\$R2"

      Push "$R0\$R2"
      Call un.coopRestoreFiles
      Pop $R3

      Goto continue

    isNotDir:
      Rename "\\?\$PLUGINSDIR\old-install$R0\$R2" "\\?\$INSTDIR$R0\$R2"

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R0 0
    FindClose $R1

    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

!endif

!macro customRemoveFiles
  System::Call 'kernel32::GetFileAttributesW(w "\\?\$INSTDIR") i .R0'
  IntOp $R0 $R0 & 0x400
  ${if} $R0 != 0
    Abort "The installation directory is unreadable or is a reparse point."
  ${endif}
  ${if} ${isUpdated}
    CreateDirectory "\\?\$PLUGINSDIR\old-install"
    Push ""
    Call un.coopAtomicRMDir
    Pop $R0
    ${if} $R0 != 0
      DetailPrint "File cannot be moved, aborting: $R0"
      Push ""
      Call un.coopRestoreFiles
      Pop $R0
      Abort "Cannot move the previous installation; its files have been restored."
    ${endif}
  ${endif}
  SetOutPath $TEMP
  RMDir /r "\\?\$INSTDIR"
!macroend
