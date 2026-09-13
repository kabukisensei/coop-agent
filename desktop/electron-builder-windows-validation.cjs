// Native acceptance installs must never share the production NSIS identity.
const installer = require("./electron-builder-installer.cjs");

module.exports = {
  ...installer,
  appId: "com.cooptimize.coop.desktop.windowsvalidation",
  productName: "Coop Desktop Windows Validation",
  executableName: "Coop Desktop",
  extraMetadata: { coopDesktopDevelopment: true },
  directories: { ...installer.directories, output: "dist-windows-validation" },
  artifactName: "Coop-Desktop-Windows-Validation-${version}-${arch}.${ext}",
  nsis: {
    ...installer.nsis,
    shortcutName: "Coop Desktop Windows Validation",
    createDesktopShortcut: false,
    createStartMenuShortcut: false,
  },
};
