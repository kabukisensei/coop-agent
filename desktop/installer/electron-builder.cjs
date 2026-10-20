// electron-builder configuration for the coop window package (master plan
// D1c, D1d, F3): an unsigned NSIS per-machine installer of the window with Node, Pi,
// the extension tree and the coop snapshot inside, Windows x64. The app it
// packs is the stage desktop/scripts/build-installer.mjs writes (desktop/, the
// lib/ modules the window imports, the vibes, the splash and the icon, plus
// pdf.js); the runtime and the snapshot ride beside the asar as
// resources\runtime and resources\coop; Electron's version is the release
// manifest's pin.
// NSIS options: one install per machine (master plan F3, Aaron 2026-10-20),
// so the installer asks for an administrator once and every Windows account
// shares the program under %ProgramFiles%\coop (each account keeps its own
// %USERPROFILE%\.coop); resources/installer.nsh adds the machine-wide step
// (scripts/machine-install.ps1: the `coop` command for every account, the
// "coop update" task). The fuses are the ones salvaged from the September
// branch (plan section 11.5); the user's data is kept on uninstall and the app
// is not started when the installer closes.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "config", "release-manifest.json"), "utf8"));
const icon = join(ROOT, "themes", "coop.ico");

module.exports = {
  appId: "com.cooptimize.coop",
  productName: "coop",
  electronVersion: manifest.desktop.electron,
  directories: {
    app: join(__dirname, "stage"),
    output: join(__dirname, "dist"),
    buildResources: join(__dirname, "resources"),
  },
  // The stage holds only what ships; electron-builder still drops its own
  // default excludes (.git, caches) and the devDependencies.
  files: ["**/*"],
  // D1d: the bundled Node, Pi, extension tree (runtime/) and the coop snapshot
  // (coop/), plain folders a child node.exe and powershell.exe read.
  extraResources: [
    { from: join(__dirname, "runtime"), to: "runtime" },
    { from: join(__dirname, "coop"), to: "coop" },
  ],
  asar: true,
  // Read by a plain node process (desktop/scripts/pdf-text.mjs), which cannot
  // open an asar.
  asarUnpack: ["node_modules/pdfjs-dist/**", "desktop/scripts/pdf-text.mjs"],
  npmRebuild: false,
  nodeGypRebuild: false,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },
  artifactName: "coop-window-${version}-${os}-${arch}.${ext}",
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon,
    // Unsigned (D1f is optional): no certificate, no signtool.
    signtoolOptions: null,
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: false,
    // F3: per machine (%ProgramFiles%\coop, HKLM, all-users shortcuts), one
    // administrator prompt; /S /allusers installs silently.
    perMachine: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // D1m: the icon is the front door, so the package's shortcut is plain "coop".
    shortcutName: "coop",
    uninstallDisplayName: "coop",
    installerIcon: icon,
    uninstallerIcon: icon,
    // D1d, F3: the welcome and finish text, the removal of this account's older
    // per-user coop, the machine-wide step and its undo on uninstall, and the
    // `coop` link and "coop" shortcuts an older package's first launch wrote
    // (resources/installer.nsh).
    include: join(__dirname, "resources", "installer.nsh"),
    artifactName: "coop-window-${version}-${os}-${arch}.${ext}",
  },
};
