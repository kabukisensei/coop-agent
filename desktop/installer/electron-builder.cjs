// electron-builder configuration for the coop window package (master plan
// D1c): an unsigned NSIS per-user installer of the window alone, Windows x64.
// The app it packs is the stage desktop/scripts/build-installer.mjs writes
// (desktop/, the lib/ modules the window imports, the vibes, the splash and
// the icon, plus pdf.js); Electron's version is the release manifest's pin.
// NSIS options and the fuses are the ones salvaged from the September branch
// (plan section 11.5): no administrator, no elevation, keep the user's data
// on uninstall, do not start the app when the installer closes.
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
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "coop (window)",
    uninstallDisplayName: "coop (window)",
    installerIcon: icon,
    uninstallerIcon: icon,
    artifactName: "coop-window-${version}-${os}-${arch}.${ext}",
  },
};
