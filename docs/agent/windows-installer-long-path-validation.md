# Native Windows uninstall regression

The NSIS installer can build successfully while its generated uninstaller fails
during the next upgrade. Electron-builder moves the previous installation into
the uninstaller's temporary plugin directory before removing it. Managed Python
and npm dependencies can exceed 260 characters at that destination even when
their installed paths are shorter. The failure restores the old installation and
reports exit code 2.

`desktop/build/windows-uninstall.nsh` supplies the custom removal hook used by
both production and isolated validation installers. Its atomic move and restore
helpers use extended Win32 paths, supported by the bundled NSIS 3.0.4.1 compiler.
No machine long-path policy or newer manifest directive is required. The restore
helper enumerates directories in the backup tree. The existing installer policy
continues to preserve app data and credentials.

The removal hook refuses an unreadable or reparse-point installation root. Its
atomic walker also refuses junctions and symbolic links inside the payload,
restoring files already moved before aborting. This prevents an upgrade from
moving files outside the installation through a junction. A native junction
fixture checks both the outside sentinel and the restored installation contents.

Run the native regression against the same compiler used for packaging:

```powershell
node desktop/scripts/verify-nsis-long-paths.mjs <path-to-makensis.exe> <existing-disposable-evidence-directory>
```

This creates disposable fixture installers and uninstallers, moves a path longer
than 260 characters, and uses a real Windows file handle to deny a later rename.
It checks that the already-moved files, including the long path, are restored
with their original contents. Evidence remains under the supplied directory.
It does not install or unregister Coop, use credentials, or modify app profiles.
The fixture includes the hook before LogicLib, matching electron-builder's
include order. The hook must load its own LogicLib dependency; otherwise real
installer compilation fails even when a fixture with LogicLib preloaded passes.
Helper functions are emitted through `customHeader`, after electron-builder
defines `UNINSTALL_FILENAME`; defining them in the initial include is too early.

An already installed version still contains its old uninstaller. For native
validation only, a short disposable TEMP/TMP path can allow that legacy program
to complete. This workaround does not establish acceptance of the new installer.
The new installed uninstaller must also pass an actual upgrade under the normal,
long temporary path. Native GUI and signed update/rollback acceptance remain
separate checks.
