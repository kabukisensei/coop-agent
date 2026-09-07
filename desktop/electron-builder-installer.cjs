// Installer builds retain the same managed runtime, app identity and fuse policy
// as development packages. Signing identities are supplied by the build worker.
const managed = require("./electron-builder-managed.cjs");

module.exports = {
  ...managed,
  directories: { ...managed.directories, output: "dist-installers" },
  artifactName: "Coop-Desktop-${version}-${os}-${arch}.${ext}",
  mac: {
    ...managed.mac,
    target: managed.mac.target.map(({ arch }) => ({ target: "dmg", arch })),
  },
  dmg: {
    title: "Coop Desktop",
    contents: [
      { x: 130, y: 160, type: "file" },
      { x: 410, y: 160, type: "link", path: "/Applications" },
    ],
  },
  win: {
    ...managed.win,
    target: managed.win.target.map(({ arch }) => ({ target: "nsis", arch })),
  },
  nsis: {
    installerIcon: "../themes/coop.ico",
    uninstallerIcon: "../themes/coop.ico",
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
  },
};
