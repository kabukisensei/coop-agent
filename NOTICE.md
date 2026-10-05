# Third-party notices

coop is MIT-licensed (`LICENSE`, Copyright (c) 2026 Cooptimize / Aaron Jennings).
It drives, launches or ships the software below. This file is the review that
master plan row L1 asked for (section 12.3, 2026-10-05): every pin in
`config/release-manifest.json` and `config/microsoft-skills.json`, its license,
the terms coop must honor, and where the notice lives. It ships with the coop
window package (the repository snapshot under `resources\coop`), so the notices
travel with the redistributed copies. Nothing here is legal advice; the gaps are
tracked as issues, never fixed silently.

## How coop distributes each component

| Mode | What it means | Components |
| --- | --- | --- |
| **Installed** | `coop install` / `coop sync` install from the public registry (npm, PyPI) on the user's machine; coop holds no copy. | Pi, the Pi extensions, the Microsoft npm tools, the Fabric and Azure DevOps MCP servers (`npx -y`), the Fabric CLI, fabric-cicd, pyodbc, coop-data-doc, teamai-cli, and Electron and pdf.js for `coop desktop` from the terminal. |
| **Launched** | coop writes the launch configuration and flags. | `@microsoft/powerbi-modeling-mcp` (`--start --readwrite --accept-eula`), `@microsoft/fabric-mcp`, `@azure-devops/mcp`. |
| **Redistributed** | The coop window installer (`coop-window-<version>-win-x64.exe`) ships copies under `resources\runtime`. | Node, Pi, the seven Pi extensions, the three Microsoft npm tools, Electron, pdf.js. |
| **Copied** | `coop sync` copies skill folders from a pinned Git revision into the agent dir. | `microsoft/skills`, `microsoft/skills-for-fabric`. |
| **Prerequisite** | Installed by the user, or by coop after the user accepts the vendor's terms. | ODBC Driver 18 for SQL Server, Azure CLI, Tabular Editor CLI. |

Installed components impose no notice duty on coop: the user receives the
upstream license files. Redistributed and copied components do, and the window
installer keeps every upstream `LICENSE` and `NOTICE` file in place (the Node zip
is unpacked whole, the npm prefix prune keeps licenses, pdf.js is unpacked beside
the asar). The entries below reproduce the copyright lines so they are also
readable in one place.

## Components

| Component | Pin | Copyright | License | Terms coop honors |
| --- | --- | --- | --- | --- |
| `@microsoft/powerbi-modeling-mcp` and `@microsoft/powerbi-modeling-mcp-win32-x64` (Microsoft Power BI Authoring MCP Server, named "Power BI Modeling MCP" in coop's docs) | 1.0.0 | Copyright (c) Microsoft Corporation | MIT in the package (`LICENSE`), plus the **Microsoft Software License Terms – Microsoft Power BI Authoring MCP Server** EULA the server requires before any tool runs (https://go.microsoft.com/fwlink/?LinkId=2381247, text in the repository's `EULA.txt`) | See "Microsoft terms" below: Cooptimize treats the package's MIT file as the license that governs its copy (Aaron, 2026-10-05), so the window installer keeps bundling it with `LICENSE` and `NOTICE.txt` in place (section 2(c)); EULA acceptance at launch; telemetry (3(a)). |
| `@microsoft/powerbi-report-authoring-cli` (`powerbi-report-author`) | 0.4.0 | Copyright (c) Microsoft Corporation | MIT; `NOTICE` lists its third-party components | Keep `LICENSE` and `NOTICE` in redistributed copies; Microsoft trademarks used descriptively only. |
| `@microsoft/powerbi-desktop-bridge-cli` (`powerbi-desktop`) | 1.0.0 | Copyright (c) Microsoft Corporation | MIT; `NOTICE` lists its third-party components | As above. |
| `@microsoft/fabric-mcp` (Fabric MCP server) | 1.4.0 | Copyright 2025 (c) Microsoft Corporation | MIT | Launched, not redistributed. Its README states it may send usage telemetry to Microsoft; see "Microsoft terms". |
| `@azure-devops/mcp` | 2.10.0 | Copyright (c) Microsoft Corporation | MIT | Launched only when Azure DevOps is enabled; trademarks used descriptively. |
| `ms-fabric-cli` (Fabric CLI, `fab`) | 1.7.0 | Copyright (c) Microsoft Corporation | MIT | Installed from PyPI; no notice duty. |
| `fabric-cicd` | 1.3.0 | Copyright (c) Microsoft Corporation | MIT | Installed from PyPI; trademarks used descriptively. |
| `pyodbc` | 5.3.0 | Michael Kleehammer | MIT-style, no notice clause | Installed from PyPI. |
| `coop-data-doc` | 1.3.1 | Copyright (c) 2026 Aaron Jennings | MIT | Cooptimize's own companion. |
| `@earendil-works/pi-coding-agent` (Pi) | 0.87.1 | Copyright (c) 2025 Mario Zechner | MIT | Redistributed in the window installer. The 0.87.1 npm tarball carries no LICENSE file, so this line is the notice that accompanies the copy: Permission is hereby granted, free of charge, to any person obtaining a copy of this software, to deal in the Software without restriction, subject to the MIT License conditions; THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. |
| `pi-mcp-adapter` | 3.3.0 | Nico Bailon | MIT | Redistributed; upstream LICENSE kept. |
| `pi-hermes-memory` | 0.9.9 | chandra447 | MIT | Redistributed; upstream LICENSE kept. |
| `pi-better-openai` | 0.1.22 | mattleong | MIT | Redistributed; upstream LICENSE kept. |
| `pi-web-access` | 0.35.0 | Nico Bailon | MIT | Redistributed; upstream LICENSE kept. |
| `@juicesharp/rpiv-ask-user-question`, `@juicesharp/rpiv-todo` | 2.12.0 | juicesharp | MIT | Redistributed; upstream LICENSE kept. |
| `@xl0/pi-lovely-rename` | 0.1.5 | Alexey Zaytsev | MIT | Redistributed; upstream LICENSE kept. |
| `teamai-cli` | 0.26.0 | Tencent | MIT | Installed only when TeamAI is enabled; not redistributed. |
| Node.js | 22.19.0 | Node.js contributors (OpenJS Foundation) | MIT, with the composite `LICENSE` of its bundled dependencies (ICU, OpenSSL, zlib, npm, V8 and others) | Redistributed whole in the window installer; `runtime/node/LICENSE` ships with it. |
| Electron | 44.5.1 | Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc. | MIT, plus Chromium's third-party licenses (`LICENSES.chromium.html`) | Redistributed; electron-builder places `LICENSE.electron.txt` and `LICENSES.chromium.html` in the app folder. |
| pdfjs-dist (pdf.js) | 6.3.289 | Mozilla Foundation | Apache-2.0, with the component licenses the package ships (Foxit and Liberation fonts, OpenJPEG, JBIG2, qcms, cmaps, ICC profiles) | Redistributed unpacked; every `LICENSE*` file ships with it. |
| `microsoft/skills` (`kql`, `microsoft-docs`) | commit `3495f50ae0d7b69dcb19c6922db9f80aab6cf79c` | Copyright (c) Microsoft Corporation | MIT | Copied into the agent dir by `coop sync`; the repository's root LICENSE is the notice (the repository's root LICENSE is the notice; #307 parked). |
| `microsoft/skills-for-fabric` | v0.3.18, commit `6c11ad58c25992e5d1435ce7cd80d217d5598a31` | Copyright (c) 2026 Microsoft Corporation | MIT | As above. |
| ODBC Driver 18 for SQL Server | winget, not pinned | Microsoft Corporation | Microsoft EULA, presented by winget | coop installs it only after the user answers "Install Microsoft ODBC Driver 18 for SQL Server and accept its license?" (`lib/common.ps1`), then passes `--accept-package-agreements`. |
| Azure CLI, Tabular Editor CLI | not pinned | Microsoft Corporation; Tabular Editor ApS | Vendor terms | Prerequisites the user installs; coop ships nothing. |

## Microsoft terms

**Power BI Authoring MCP EULA.** The server refuses every tool until the EULA is
accepted. coop launches it with `--accept-eula` because Aaron Jennings accepted
the EULA for Cooptimize on 2026-09-30; running coop with the Power BI Modeling
MCP enabled means using that server under those terms. Read them before you
enable it: https://go.microsoft.com/fwlink/?LinkId=2381247 (the repository copy
is `EULA.txt` in https://github.com/microsoft/powerbi-modeling-mcp). Two clauses
matter to coop beyond acceptance: section 2(c), coop must not remove or hide
Microsoft's notices (the package's `NOTICE.txt` and `LICENSE` stay in place), and
section 2(e), the software may not be shared, published or distributed to a third
party, while the same npm package ships an MIT `LICENSE` that permits
redistribution. **Cooptimize's call (Aaron, 2026-10-05, issue #304):** treat the
MIT file in the package as the license that governs coop's copy, keep bundling
the server in the coop window installer as is, and record that reasoning here
rather than ask Microsoft for written permission. This is a decision Cooptimize
owns, taken while the team is small, and it is revisited if Microsoft changes the
package's license files or objects. coop does not show the EULA to each
worker-owner before launch (issue #305, same day): the acceptance recorded here
and on the website's privacy page is the record, and the server's own
`--accept-eula` flag is the only acceptance it asks for.

**Telemetry.** The Power BI Authoring MCP EULA (section 3(a)) and the Fabric MCP
README both state that the software may collect information about you and your
use of it and send it to Microsoft, with use as consent, under Microsoft's
privacy statement (https://www.microsoft.com/privacy/privacystatement). Neither
package documents an opt-out setting for the npm form, so coop sets none. The
website's privacy page lists this under what leaves your machine.

**Trademarks.** Microsoft's READMEs point to the Microsoft Trademark & Brand
Guidelines. coop names Microsoft Fabric, Power BI, Azure and Azure DevOps
descriptively and uses no Microsoft logos.

## Decisions and open items

Aaron decided the four findings of this review on 2026-10-05:

- #304, decided: the window installer keeps bundling the Power BI Authoring MCP server; the package's MIT `LICENSE` is taken as governing (see "Microsoft terms").
- #305, decided: coop does not ask each user to accept the EULA; this file and the privacy page record Cooptimize's acceptance.
- #306, parked: the installer check does not assert the redistributed license files; the window package keeps shipping them as electron-builder and the npm prune leave them, with no gate that could stop a build.
- #307, parked: the Microsoft skills catalog keeps copying the skill folders as the pinned revisions hold them; the repositories' root MIT LICENSE files are the notice, as the table above says.

## What could not be verified from the review machine

The EULA text behind the `go.microsoft.com` link (the repository's `EULA.txt` on
`main` was read instead; the package changelog says 1.0.0 updated the EULA to
the GA version), a telemetry opt-out for either MCP server, the Electron and
Chromium license files inside a built installer (relied on electron-builder's
documented default; #306 parked, no check asserts it), and each Pi extension tarball's own
LICENSE file (registry metadata only). Sources: the npm and PyPI registry
metadata and tarballs for each pin, the LICENSE, README and EULA files of each
repository at the pinned revision.
